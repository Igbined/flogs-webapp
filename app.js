const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const path = require('path');
const multer = require('multer');
const User = require('./models/User');
const { Config } = require('./models/User');
const { configureMiddleware, requireAuth, requireAdminAuth } = require('./middleware');
const { connectDatabase } = require('./config/database');

const app = express();
const port = process.env.PORT || 3000;
const host = process.env.HOST || '0.0.0.0';
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1
  }
});

function getEnvValue(...keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (value && String(value).trim()) return String(value).trim();
  }
  return '';
}

async function getConfigValue(key, fallbackEnvKey) {
  try {
    const config = await Config.findOne({ key });
    if (config?.value && String(config.value).trim()) {
      return String(config.value).trim();
    }
  } catch (error) {
    console.error(`Error reading config key ${key}:`, error.message);
  }
  return fallbackEnvKey ? getEnvValue(fallbackEnvKey) : '';
}

const QUESTPAY_BASE_URL = 'https://payments-server.questlabs.cc/api';

async function initializeQuestpayCheckout({ user, amount, tokens, reference, returnUrl }) {
  const apiKey = await getConfigValue('questpay_api_key', 'QUESTPAY_API_KEY');
  if (!apiKey) {
    throw new Error('QUESTPAY_API_KEY is not configured.');
  }

  const response = await fetch(`${QUESTPAY_BASE_URL}/v2/checkout/initialize`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      reference,
      email: user.email,
      amount,
      description: `Wallet top-up (${tokens} token${tokens === 1 ? '' : 's'})`,
      metadata: {
        userId: String(user._id),
        tokenAmount: Number(tokens),
        amountNaira: Number(amount)
      },
      return_url: returnUrl
    })
  });

  const payload = await response.json();
  if (!response.ok || !payload?.success || !payload?.data?.checkout_url) {
    const message = payload?.message || 'QuestPay checkout initialization failed.';
    throw new Error(message);
  }

  return payload.data;
}

async function verifyQuestpayCheckout(reference) {
  const apiKey = await getConfigValue('questpay_api_key', 'QUESTPAY_API_KEY');
  if (!apiKey) {
    throw new Error('QUESTPAY_API_KEY is not configured.');
  }

  const response = await fetch(`${QUESTPAY_BASE_URL}/v2/checkout/verify/${encodeURIComponent(reference)}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`
    }
  });

  const payload = await response.json();
  if (!response.ok || !payload?.success) {
    const message = payload?.message || 'QuestPay verification failed.';
    throw new Error(message);
  }

  return payload.data || null;
}

async function creditUserFromQuestpay({ userId, tokenAmount, reference, amountNaira }) {
  const user = await User.findById(userId);
  if (!user) return { credited: false, reason: 'user-not-found' };

  const creditsToAdd = Number(tokenAmount) || Math.max(0, Math.round((Number(amountNaira) || 0) / 5100));
  user.credits = user.credits || { balance: 0, lifetimePurchased: 0, lifetimeUsed: 0 };
  user.credits.balance = (Number(user.credits.balance) || 0) + creditsToAdd;
  user.credits.lifetimePurchased = (Number(user.credits.lifetimePurchased) || 0) + creditsToAdd;

  const existingPayment = Array.isArray(user.payments?.questpay)
    ? user.payments.questpay.find((entry) => entry.reference === reference)
    : null;

  if (!existingPayment) {
    const payments = Array.isArray(user.payments?.questpay) ? user.payments.questpay : [];
    user.payments = user.payments || {};
    user.payments.questpay = [
      ...payments,
      {
        reference,
        amountNaira: Number(amountNaira) || 0,
        tokenAmount: Number(creditsToAdd),
        status: 'paid',
        paidAt: new Date()
      }
    ];
  }

  await user.save();
  return { credited: true, creditsAdded: creditsToAdd };
}

async function sendTelegramAdminNotification({ user, platform, contestName, duration, tokenSpent, imageFile }) {
  const adminToken = await getConfigValue('telegram_admin_token', 'TELEGRAM_ADMIN_TOKEN');
  const adminChatId = await getConfigValue('telegram_admin_id', 'TELEGRAM_ADMIN_ID');

  if (!adminToken || !adminChatId) {
    throw new Error('Telegram admin configuration is missing. Add TELEGRAM_ADMIN_TOKEN and TELEGRAM_ADMIN_ID to your environment.');
  }

  const userName = user?.name || 'Unknown user';
  const userTelegramId = user?.integrations?.telegram?.chatId || 'Not connected';
  const messageText = [
    'NEW GENERATION REQUEST',
    `FROM: ${userName}`,
    `PLATFORM: ${platform}`,
    `NAME: ${contestName}`,
    `TELEGRAM: ${userTelegramId}`,
    `DURATION: ${duration}`,
    `TOKEN SPENT: ${tokenSpent}`
  ].join('\n');

  const sendTextMessage = async () => {
    const textUrl = `https://api.telegram.org/bot${adminToken}/sendMessage`;
    const textResponse = await fetch(textUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        chat_id: String(adminChatId),
        text: messageText
      })
    });

    const textData = await textResponse.json();
    if (!textData.ok) {
      throw new Error(textData.description || 'Telegram text notification failed.');
    }

    return textData;
  };

  if (!imageFile || !imageFile.buffer) {
    return sendTextMessage();
  }

  const photoUrl = `https://api.telegram.org/bot${adminToken}/sendPhoto`;
  const payload = new FormData();
  payload.append('chat_id', String(adminChatId));
  payload.append('caption', messageText);
  payload.append('photo', new Blob([imageFile.buffer], { type: imageFile.mimetype || 'image/jpeg' }), imageFile.originalname || 'contest-image.jpg');

  try {
    const response = await fetch(photoUrl, {
      method: 'POST',
      body: payload
    });

    const data = await response.json();
    if (data.ok) {
      return data;
    }

    if (data.description && /no photo|bad request|not found/i.test(data.description)) {
      return sendTextMessage();
    }

    throw new Error(data.description || 'Telegram image notification failed.');
  } catch (error) {
    if (error && error.message && /not found|no photo|bad request/i.test(error.message)) {
      return sendTextMessage();
    }

    throw error;
  }
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

configureMiddleware(app);

const databaseConnection = connectDatabase();

app.use(async (request, response, next) => {
  try {
    await databaseConnection;
    next();
  } catch (error) {
    next(error);
  }
});

app.get('/health', (request, response) => {
  response.status(200).json({ status: 'ok' });
});

function renderAuthError(response, view, message) {
  return response.status(400).render(view, {
    pageTitle: view === 'signup' ? 'Flogs — Sign Up' : 'Flogs — Log In',
    error: message
  });
}

function startUserSession(request, userId, options = {}) {
  return new Promise((resolve, reject) => {
    request.session.regenerate((error) => {
      if (error) return reject(error);

      request.session.userId = userId.toString();
      if (options.registrationSuccess) request.session.registrationSuccess = true;

      request.session.save((saveError) => {
        if (saveError) return reject(saveError);
        resolve();
      });
    });
  });
}

app.get('/', (request, response) => {
  response.render('index', { pageTitle: 'Flogs — Generate Campaigns. Ship Faster.' });
});

app.get('/login', (request, response) => {
  response.render('login', { pageTitle: 'Flogs — Log In' });
});

app.get('/admin_login', (request, response) => {
  response.render('admin/login', { pageTitle: 'Flogs — Admin Login', error: null });
});

app.post('/admin_login', async (request, response, next) => {
  try {
    const email = String(request.body.email || '').trim().toLowerCase();
    const password = String(request.body.password || '');
    const user = await User.findOne({ email }).select('+passwordHash');

    if (!user || user.role !== 'admin' || !(await bcrypt.compare(password, user.passwordHash))) {
      return response.status(400).render('admin/login', {
        pageTitle: 'Flogs — Admin Login',
        error: 'Invalid admin credentials.'
      });
    }

    request.session.userId = user._id.toString();
    request.session.userRole = 'admin';
    response.redirect('/admin');
  } catch (error) {
    next(error);
  }
});

app.get('/signup', (request, response) => {
  response.render('signup', { pageTitle: 'Flogs — Sign Up' });
});

app.post('/signup', async (request, response, next) => {
  try {
    const name = String(request.body.name || '').trim();
    const email = String(request.body.email || '').trim().toLowerCase();
    const password = String(request.body.password || '');

    if (name.length < 2 || name.length > 120) {
      return renderAuthError(response, 'signup', 'Enter a valid full name.');
    }

    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return renderAuthError(response, 'signup', 'Enter a valid email address.');
    }

    if (password.length < 8 || password.length > 128) {
      return renderAuthError(response, 'signup', 'Password must be between 8 and 128 characters.');
    }

    const existingUser = await User.exists({ email });
    if (existingUser) {
      return renderAuthError(response, 'signup', 'An account already exists for that email.');
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await User.create({ name, email, passwordHash });

    await startUserSession(request, user._id, { registrationSuccess: true });
    response.redirect('/dashboard');
  } catch (error) {
    if (error.code === 11000) {
      return renderAuthError(response, 'signup', 'An account already exists for that email.');
    }

    next(error);
  }
});

app.post('/login', async (request, response, next) => {
  try {
    const email = String(request.body.email || '').trim().toLowerCase();
    const password = String(request.body.password || '');
    const user = await User.findOne({ email }).select('+passwordHash');

    if (!user || user.status !== 'active' || !(await bcrypt.compare(password, user.passwordHash))) {
      return renderAuthError(response, 'login', 'Invalid email or password.');
    }

    user.security.lastLoginAt = new Date();
    user.security.failedLoginAttempts = 0;
    await user.save();

    await startUserSession(request, user._id);
    response.redirect('/dashboard');
  } catch (error) {
    next(error);
  }
});

app.post('/logout', (request, response, next) => {
  request.session.destroy((error) => {
    if (error) return next(error);
    response.clearCookie('connect.sid');
    response.redirect('/login');
  });
});

app.use('/admin', requireAdminAuth);

app.get('/admin', async (request, response, next) => {
  try {
    const adminUser = await User.findById(request.session.userId);
    const users = await User.find({}).sort({ createdAt: -1 }).select('name email role credits.balance linkHistory');
    response.render('admin/index', {
      pageTitle: 'Flogs — Admin Dashboard',
      activeNav: 'overview',
      user: adminUser,
      users
    });
  } catch (error) {
    next(error);
  }
});

app.get('/admin/generation-requests', async (request, response, next) => {
  try {
    const users = await User.find({}).sort({ createdAt: -1 }).select('name email linkHistory');
    const requests = users.flatMap((user) => (Array.isArray(user.linkHistory) ? user.linkHistory
      .filter((item) => (item.status || 'pending_generation') === 'pending_generation')
      .map((item) => ({
        userId: user._id,
        userName: user.name,
        userEmail: user.email,
        requestId: item.requestId || item._id?.toString?.() || `${user._id}-${Date.now()}`,
        title: item.title || 'Campaign Link',
        platform: item.platform || 'Instagram',
        duration: item.duration || '1 week',
        tokens: item.tokens || 1,
        status: item.status || 'pending_generation',
        generatedUrl: item.generatedUrl || null,
        createdAt: item.createdAt || new Date()
      })) : []));

    response.render('admin/generation-requests', {
      pageTitle: 'Flogs — Generation Requests',
      activeNav: 'generation',
      requests: requests.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    });
  } catch (error) {
    next(error);
  }
});

app.post('/admin/generation-requests/:userId/:requestId', async (request, response, next) => {
  try {
    const user = await User.findById(request.params.userId);
    if (!user || !Array.isArray(user.linkHistory)) {
      return response.redirect('/admin/generation-requests');
    }

    const requestId = request.params.requestId;
    const generatedUrl = String(request.body.generatedUrl || '').trim();
    const item = user.linkHistory.find((entry) => (entry.requestId || entry._id?.toString?.()) === requestId);

    if (!item) {
      return response.redirect('/admin/generation-requests');
    }

    item.generatedUrl = generatedUrl || item.generatedUrl || null;
    item.status = generatedUrl ? 'generated' : 'pending_generation';
    item.respondedAt = generatedUrl ? new Date() : item.respondedAt || null;
    await user.save();
    response.redirect('/admin/generation-requests');
  } catch (error) {
    next(error);
  }
});

app.get('/admin/credit', async (request, response, next) => {
  try {
    const users = await User.find({}).sort({ createdAt: -1 }).select('name email credits.balance');
    const message = request.session.adminCreditMessage;
    delete request.session.adminCreditMessage;

    response.render('admin/credit', {
      pageTitle: 'Flogs — Admin Credit',
      activeNav: 'credit',
      users,
      message
    });
  } catch (error) {
    next(error);
  }
});

app.post('/admin/credit', async (request, response, next) => {
  try {
    const userId = String(request.body.userId || '').trim();
    const tokenAmount = Number(request.body.amount || 0);

    if (!userId || !Number.isFinite(tokenAmount) || tokenAmount <= 0) {
      request.session.adminCreditMessage = { type: 'error', text: 'Please select a user and enter a valid token amount.' };
      return response.redirect('/admin/credit');
    }

    const user = await User.findById(userId);
    if (!user) {
      request.session.adminCreditMessage = { type: 'error', text: 'Selected user was not found.' };
      return response.redirect('/admin/credit');
    }

    user.credits.balance = (Number(user.credits?.balance) || 0) + tokenAmount;
    user.credits.lifetimePurchased = (Number(user.credits?.lifetimePurchased) || 0) + tokenAmount;
    await user.save();

    request.session.adminCreditMessage = {
      type: 'success',
      text: `Credited ${tokenAmount} token${tokenAmount === 1 ? '' : 's'} to ${user.name}.`
    };
    response.redirect('/admin/credit');
  } catch (error) {
    next(error);
  }
});

app.post('/webhooks/questpay', async (request, response) => {
  const signatureHeader = String(request.headers['x-questpay-signature'] || '');
  const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.from(String(request.body || ''));
  const apiKey = getEnvValue('QUESTPAY_API_KEY');

  if (!apiKey) {
    return response.status(500).send('QuestPay API key is not configured.');
  }

  const calculatedSignature = crypto.createHmac('sha256', apiKey).update(rawBody).digest('hex');
  const expectedSignature = Buffer.from(calculatedSignature, 'utf8');
  const receivedSignature = Buffer.from(signatureHeader, 'utf8');

  if (expectedSignature.length !== receivedSignature.length || !crypto.timingSafeEqual(expectedSignature, receivedSignature)) {
    return response.status(400).send('Invalid QuestPay signature');
  }

  let payload = {};
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (error) {
    return response.status(400).send('Invalid QuestPay payload');
  }

  const eventName = String(payload?.event || '').trim();
  const data = payload?.data || {};
  const reference = String(data?.reference || '').trim();
  const status = String(data?.status || '').trim();

  if (eventName === 'payment.received' && status === 'success') {
    const userId = String(data?.metadata?.userId || '').trim();
    const tokenAmount = Number(data?.metadata?.tokenAmount || data?.metadata?.tokens || 0);
    const amountNaira = Number(data?.amount || data?.fees?.grossAmount || data?.transaction?.gross_amount || 0);

    if (userId) {
      await creditUserFromQuestpay({
        userId,
        tokenAmount,
        reference,
        amountNaira
      });
    }
  }

  if (eventName === 'checkout.failed') {
    console.log('QuestPay checkout failed', { reference, eventName, status, metadata: data?.metadata || null });
  }

  return response.status(200).json({ success: true, received: true });
});

app.get('/admin/settings', async (request, response, next) => {
  try {
    const message = request.session.settingsMessage;
    delete request.session.settingsMessage;

    const tokenPriceConfig = await Config.findOne({ key: 'tokenPrice' });
    const telegramTokenConfig = await Config.findOne({ key: 'telegram_admin_token' });
    const telegramIdConfig = await Config.findOne({ key: 'telegram_admin_id' });
    const questpayKeyConfig = await Config.findOne({ key: 'questpay_api_key' });
    const appBaseUrlConfig = await Config.findOne({ key: 'app_base_url' });

    const tokenPrice = tokenPriceConfig?.value || 5100;
    const telegramToken = telegramTokenConfig?.value || '';
    const telegramId = telegramIdConfig?.value || '';
    const questpayKey = questpayKeyConfig?.value || '';
    const appBaseUrl = appBaseUrlConfig?.value || '';

    response.render('admin/settings', {
      pageTitle: 'Flogs — Admin Settings',
      activeNav: 'settings',
      tokenPrice,
      telegramToken,
      telegramId,
      questpayKey,
      appBaseUrl,
      message
    });
  } catch (error) {
    next(error);
  }
});

app.post('/admin/settings/update-token-price', async (request, response, next) => {
  try {
    const tokenPrice = Number(request.body.tokenPrice || 0);

    if (!Number.isFinite(tokenPrice) || tokenPrice <= 0) {
      request.session.settingsMessage = { type: 'error', text: 'Please enter a valid token price.' };
      return response.redirect('/admin/settings');
    }

    await Config.updateOne(
      { key: 'tokenPrice' },
      { key: 'tokenPrice', value: tokenPrice, description: 'Price in Naira per token for user purchases' },
      { upsert: true }
    );

    request.session.settingsMessage = {
      type: 'success',
      text: `Token price updated to ₦${tokenPrice.toLocaleString('en-NG')}.`
    };
    response.redirect('/admin/settings');
  } catch (error) {
    next(error);
  }
});

app.post('/admin/settings/update-config', async (request, response, next) => {
  try {
    const { telegramToken, telegramId, questpayKey, appBaseUrl } = request.body;
    const updates = [];

    if (telegramToken) {
      updates.push(Config.updateOne(
        { key: 'telegram_admin_token' },
        { key: 'telegram_admin_token', value: String(telegramToken).trim(), description: 'Telegram Admin Bot Token' },
        { upsert: true }
      ));
    }

    if (telegramId) {
      updates.push(Config.updateOne(
        { key: 'telegram_admin_id' },
        { key: 'telegram_admin_id', value: String(telegramId).trim(), description: 'Telegram Admin Chat ID' },
        { upsert: true }
      ));
    }

    if (questpayKey) {
      updates.push(Config.updateOne(
        { key: 'questpay_api_key' },
        { key: 'questpay_api_key', value: String(questpayKey).trim(), description: 'QuestPay API Secret Key' },
        { upsert: true }
      ));
    }

    if (appBaseUrl) {
      updates.push(Config.updateOne(
        { key: 'app_base_url' },
        { key: 'app_base_url', value: String(appBaseUrl).trim(), description: 'Application Base URL for callbacks' },
        { upsert: true }
      ));
    }

    if (updates.length > 0) {
      await Promise.all(updates);
      request.session.settingsMessage = {
        type: 'success',
        text: 'Configuration settings updated successfully.'
      };
    } else {
      request.session.settingsMessage = {
        type: 'error',
        text: 'No settings to update.'
      };
    }

    response.redirect('/admin/settings');
  } catch (error) {
    next(error);
  }
});

app.use('/dashboard', requireAuth);

app.get('/dashboard', async (request, response, next) => {
  try {
    const user = await User.findById(request.session.userId);
    if (!user || user.status !== 'active') {
      request.session.destroy(() => response.redirect('/login'));
      return;
    }
    const registrationSuccess = request.session.registrationSuccess === true;
    delete request.session.registrationSuccess;
    response.render('dashboard/index', {
      pageTitle: 'Flogs Dashboard',
      activeNav: 'home',
      user,
      registrationSuccess,
      totalLinks: user.linkHistory ? user.linkHistory.length : 0
    });
  } catch (error) {
    next(error);
  }
});

app.post('/dashboard', async (request, response, next) => {
  try {
    const chatId = String(request.body.chatId || '').trim();
    if (!chatId) return response.redirect('/dashboard');

    await User.findByIdAndUpdate(request.session.userId, {
      'integrations.telegram.chatId': chatId,
      'integrations.telegram.enabled': true,
      'integrations.telegram.connectedAt': new Date()
    });
    response.redirect('/dashboard');
  } catch (error) {
    next(error);
  }
});

app.get('/dashboard/genrate', (request, response) => {
  response.render('dashboard/generate/index', { pageTitle: 'Flogs — Generate Link' });
});

app.get('/dashboard/onboarding/socials', (request, response) => {
  const message = request.session.generationMessage;
  delete request.session.generationMessage;
  response.render('dashboard/onboarding/socials/index', {
    pageTitle: 'Flogs — Socials',
    message
  });
});

app.post('/dashboard/onboarding/socials', upload.single('image'), async (request, response, next) => {
  try {
    const user = await User.findById(request.session.userId);
    if (!user || user.status !== 'active') {
      request.session.destroy(() => response.redirect('/login'));
      return;
    }

    const platform = String(request.body.platform || 'Instagram').trim() || 'Instagram';
    const contestName = String(request.body.contestantName || '').trim();
    const duration = String(request.body.duration || '1 week').trim();
    const tokenSpent = Number(request.body.tokens || '1');
    const imageFile = request.file;

    if (!imageFile) {
      request.session.generationMessage = {
        type: 'error',
        text: 'Please upload an image first before generating your contest.'
      };
      return response.redirect('/dashboard/onboarding/socials');
    }

    if (!user.integrations || !user.integrations.telegram || !user.integrations.telegram.chatId) {
      request.session.generationMessage = {
        type: 'error',
        text: 'Please set your Telegram chat ID first before generating a link.'
      };
      return response.redirect('/dashboard/onboarding/socials');
    }

    const validDurations = {
      '1 week': 1,
      '2 weeks': 2,
      '3 weeks': 3,
      '1 month': 4,
      '2 months': 8,
      '3 months': 12
    };

    const expectedTokens = validDurations[duration] || null;

    if (!contestName) {
      request.session.generationMessage = { type: 'error', text: 'Please enter a contest name before submitting.' };
      return response.redirect('/dashboard/onboarding/socials');
    }

    if (!expectedTokens || Number(tokenSpent) !== expectedTokens) {
      request.session.generationMessage = {
        type: 'error',
        text: 'The selected duration does not match the token value. Please choose a valid duration.'
      };
      return response.redirect('/dashboard/onboarding/socials');
    }

    if ((Number(user.credits?.balance) || 0) < expectedTokens) {
      request.session.generationMessage = {
        type: 'error',
        text: 'You do not have enough tokens for this request. Please buy tokens first.'
      };
      return response.redirect('/dashboard/onboarding/socials');
    }

    user.credits = user.credits || { balance: 0, lifetimePurchased: 0, lifetimeUsed: 0 };
    user.credits.balance = (Number(user.credits.balance) || 0) - expectedTokens;
    user.credits.lifetimeUsed = (Number(user.credits.lifetimeUsed) || 0) + expectedTokens;

    const pendingEntry = {
      title: contestName,
      platform,
      duration,
      tokens: expectedTokens,
      status: 'pending_generation',
      createdAt: new Date(),
      requestId: request.requestId
    };

    user.linkHistory = Array.isArray(user.linkHistory) ? [pendingEntry, ...user.linkHistory] : [pendingEntry];
    await user.save();

    await sendTelegramAdminNotification({
      user,
      platform,
      contestName,
      duration,
      tokenSpent: String(expectedTokens),
      imageFile
    });

    response.redirect('/dashboard/links');
  } catch (error) {
    next(error);
  }
});

app.get('/dashboard/links', async (request, response, next) => {
  try {
    const user = await User.findById(request.session.userId);
    if (!user || user.status !== 'active') {
      request.session.destroy(() => response.redirect('/login'));
      return;
    }

    const linkHistory = Array.isArray(user.linkHistory)
      ? user.linkHistory.map((item) => ({
        title: item.title || 'Campaign link',
        platform: item.platform || 'Instagram',
        duration: item.duration || '1 week',
        tokens: Number(item.tokens) || 1,
        status: item.status || 'pending_generation',
        generatedUrl: item.generatedUrl || null,
        requestId: item.requestId || item._id?.toString?.() || null,
        createdAt: item.createdAt || new Date(),
        respondedAt: item.respondedAt || null
      }))
      : [];

    if (request.query.json === '1') {
      return response.json({ linkHistory });
    }

    response.render('dashboard/links/index', {
      pageTitle: 'Flogs — My Links',
      activeNav: 'links',
      linkHistory
    });
  } catch (error) {
    next(error);
  }
});

app.post('/dashboard/links/:requestId/delete', async (request, response, next) => {
  try {
    const user = await User.findById(request.session.userId);
    if (!user || user.status !== 'active') {
      if (request.accepts('json')) {
        return response.status(401).json({ ok: false, error: 'Unauthorized' });
      }
      request.session.destroy(() => response.redirect('/login'));
      return;
    }

    const requestId = String(request.params.requestId || '').trim();
    if (!requestId) {
      if (request.accepts('json')) return response.status(400).json({ ok: false, error: 'Missing request id' });
      return response.redirect('/dashboard/links');
    }

    const itemToDelete = Array.isArray(user.linkHistory)
      ? user.linkHistory.find((item) => (item.requestId || item._id?.toString?.()) === requestId)
      : null;

    const shouldRefund = Boolean(itemToDelete)
      && (itemToDelete.status || 'pending_generation') === 'pending_generation'
      && !itemToDelete.generatedUrl;

    if (shouldRefund) {
      const refundTokens = Number(itemToDelete.tokens) || 0;
      if (refundTokens > 0) {
        user.credits = user.credits || { balance: 0, lifetimePurchased: 0, lifetimeUsed: 0 };
        user.credits.balance = (Number(user.credits.balance) || 0) + refundTokens;
      }
    }

    const before = user.linkHistory.length;
    user.linkHistory = Array.isArray(user.linkHistory)
      ? user.linkHistory.filter((item) => (item.requestId || item._id?.toString?.()) !== requestId)
      : [];

    await user.save();

    if (request.accepts('json')) {
      return response.json({ ok: true, removed: before !== user.linkHistory.length, refunded: shouldRefund });
    }

    response.redirect('/dashboard/links');
  } catch (error) {
    next(error);
  }
});

app.get('/dashboard/credit', async (request, response, next) => {
  try {
    const message = request.session.creditMessage;
    delete request.session.creditMessage;
    const tokenPriceConfig = await Config.findOne({ key: 'tokenPrice' });
    const tokenPrice = tokenPriceConfig?.value || 5100;

    response.render('dashboard/credit/index', {
      pageTitle: 'Flogs — Buy Credit',
      activeNav: 'credit',
      message,
      tokenPrice
    });
  } catch (error) {
    next(error);
  }
});

app.get('/dashboard/credit/complete', async (request, response, next) => {
  try {
    const reference = String(request.query.ref || '').trim();
    if (!reference) {
      request.session.creditMessage = { type: 'error', text: 'No checkout reference was returned by QuestPay.' };
      return response.redirect('/dashboard/credit');
    }

    const paymentData = await verifyQuestpayCheckout(reference);
    if (paymentData?.status === 'paid') {
      const metadataUserId = String(paymentData?.metadata?.userId || '').trim();
      const tokenAmount = Number(paymentData?.metadata?.tokenAmount || paymentData?.metadata?.tokens || 0);
      const amountNaira = Number(paymentData?.amount || paymentData?.transaction?.amount || paymentData?.transaction?.gross_amount || 0);

      if (metadataUserId) {
        await creditUserFromQuestpay({
          userId: metadataUserId,
          tokenAmount,
          reference,
          amountNaira
        });
      }

      request.session.creditMessage = {
        type: 'success',
        text: `Your QuestPay payment was confirmed and ${tokenAmount || 'the purchased'} token${(tokenAmount || 1) === 1 ? '' : 's'} have been credited.`
      };
      return response.redirect('/dashboard/credit');
    }

    request.session.creditMessage = {
      type: 'error',
      text: 'Your QuestPay payment is still pending or was not completed.'
    };
    return response.redirect('/dashboard/credit');
  } catch (error) {
    request.session.creditMessage = {
      type: 'error',
      text: 'QuestPay verification failed. Please contact support if this persists.'
    };
    response.redirect('/dashboard/credit');
  }
});

app.post('/dashboard/credit/checkout', async (request, response, next) => {
  try {
    const user = await User.findById(request.session.userId);
    if (!user || user.status !== 'active') {
      request.session.destroy(() => response.redirect('/login'));
      return;
    }

    const tokens = Number(request.body.tokens || 0);
    if (!Number.isFinite(tokens) || tokens <= 0) {
      return response.status(400).json({ success: false, message: 'Please enter a valid token amount.' });
    }

    const tokenPriceConfig = await Config.findOne({ key: 'tokenPrice' });
    const tokenPrice = tokenPriceConfig?.value || 5100;
    const amount = tokens * tokenPrice;
    const reference = `TOPUP-${user._id}-${Date.now()}`;
    const baseUrl = getEnvValue('APP_BASE_URL', 'FRONTEND_URL', 'SITE_URL') || `${request.protocol}://${request.get('host')}`;

    const checkoutData = await initializeQuestpayCheckout({
      user,
      amount,
      tokens,
      reference,
      returnUrl: `${baseUrl}/dashboard/credit/complete?ref=${encodeURIComponent(reference)}`
    });

    response.json({
      success: true,
      reference,
      checkoutUrl: checkoutData.checkout_url,
      amount,
      tokens
    });
  } catch (error) {
    next(error);
  }
});

app.get('/dashboard/transactions', async (request, response, next) => {
  try {
    const user = await User.findById(request.session.userId);
    const transactions = (Array.isArray(user?.payments?.questpay) ? user.payments.questpay : [])
      .map((entry) => ({
        reference: entry.reference || 'N/A',
        amountNaira: Number(entry.amountNaira) || 0,
        tokenAmount: Number(entry.tokenAmount) || 0,
        status: String(entry.status || 'pending').toLowerCase(),
        paidAt: entry.paidAt || new Date()
      }))
      .sort((a, b) => new Date(b.paidAt) - new Date(a.paidAt));

    response.render('dashboard/transactions/index', {
      pageTitle: 'Flogs — Transactions',
      transactions
    });
  } catch (error) {
    next(error);
  }
});

app.get('/dashboard/settings', (request, response) => {
  const passwordMessage = request.session.passwordMessage;
  delete request.session.passwordMessage;
  response.render('dashboard/settings/index', { pageTitle: 'Flogs — Settings', passwordMessage });
});

app.post('/dashboard/settings/password', async (request, response, next) => {
  try {
    const currentPassword = String(request.body.currentPassword || '');
    const newPassword = String(request.body.newPassword || '');
    const confirmPassword = String(request.body.confirmPassword || '');
    const user = await User.findById(request.session.userId).select('+passwordHash');

    if (!user || user.status !== 'active') {
      request.session.destroy(() => response.redirect('/login'));
      return;
    }

    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      request.session.passwordMessage = { type: 'error', text: 'Current password is incorrect.' };
      return response.redirect('/dashboard/settings');
    }

    if (newPassword.length < 8 || newPassword.length > 128) {
      request.session.passwordMessage = { type: 'error', text: 'New password must be between 8 and 128 characters.' };
      return response.redirect('/dashboard/settings');
    }

    if (newPassword !== confirmPassword) {
      request.session.passwordMessage = { type: 'error', text: 'New passwords do not match.' };
      return response.redirect('/dashboard/settings');
    }

    user.passwordHash = await bcrypt.hash(newPassword, 12);
    user.security.passwordChangedAt = new Date();
    await user.save();
    request.session.passwordMessage = { type: 'success', text: 'Password updated successfully.' };
    response.redirect('/dashboard/settings');
  } catch (error) {
    next(error);
  }
});

app.get('/dashboard/sms-verify', (request, response) => {
  response.render('dashboard/sms-verify/index', { pageTitle: 'Flogs — SMS Verify' });
});

app.use((error, request, response, next) => {
  const isDatabaseError = error.name === 'MongoServerSelectionError'
    || error.name === 'MongoNetworkError'
    || error.name === 'MongooseError'
    || error.name === 'MongoParseError';

  console.error('Request failed', {
    requestId: request.requestId,
    method: request.method,
    path: request.originalUrl,
    name: error.name,
    code: error.code,
    message: error.message,
    stack: error.stack
  });

  if (response.headersSent) return next(error);

  response.status(isDatabaseError ? 503 : 500).json({
    error: 'Internal server error',
    requestId: request.requestId,
    errorType: isDatabaseError ? 'DATABASE_UNAVAILABLE' : 'REQUEST_FAILED',
    details: error.message,
    ...(process.env.DEBUG_ERRORS === 'true' ? { code: error.code || null } : {})
  });
});

let server;

if (!process.env.VERCEL) {
  databaseConnection
    .then(() => {
      server = app.listen(port, host, () => {
        console.log(`Server running on ${host}:${port}`);
      });
    })
    .catch((error) => {
      console.error('MongoDB connection failed:', error.message);
      process.exitCode = 1;
    });
}

function shutDown(signal) {
  console.log(`${signal} received, shutting down`);
  if (!server) return process.exit(0);

  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutDown('SIGTERM'));
process.on('SIGINT', () => shutDown('SIGINT'));

module.exports = app;