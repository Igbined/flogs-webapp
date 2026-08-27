const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('./models/User');
const { configureMiddleware, requireAuth } = require('./middleware');
const { connectDatabase } = require('./config/database');

const app = express();
const port = process.env.PORT || 3000;
const host = process.env.HOST || '0.0.0.0';

app.set('view engine', 'ejs');
app.set('views', './views');

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
    response.render('dashboard/index', { pageTitle: 'Flogs Dashboard', activeNav: 'home', user, registrationSuccess });
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
  response.render('dashboard/onboarding/socials/index', { pageTitle: 'Flogs — Socials' });
});

app.get('/dashboard/links', (request, response) => {
  response.render('dashboard/links/index', { pageTitle: 'Flogs — My Links', activeNav: 'links' });
});

app.get('/dashboard/credit', (request, response) => {
  response.render('dashboard/credit/index', { pageTitle: 'Flogs — Buy Credit' });
});

app.get('/dashboard/transactions', (request, response) => {
  response.render('dashboard/transactions/index', { pageTitle: 'Flogs — Transactions' });
});

app.get('/dashboard/settings', (request, response) => {
  response.render('dashboard/settings/index', { pageTitle: 'Flogs — Settings' });
});

app.get('/dashboard/sms-verify', (request, response) => {
  response.render('dashboard/sms-verify/index', { pageTitle: 'Flogs — SMS Verify' });
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