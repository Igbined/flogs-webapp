const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 120
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 254
    },
    passwordHash: {
      type: String,
      required: true,
      select: false
    },
    role: {
      type: String,
      enum: ['user', 'admin'],
      default: 'user'
    },
    status: {
      type: String,
      enum: ['pending_verification', 'active', 'suspended', 'deleted'],
      default: 'active'
    },
    profile: {
      avatarUrl: { type: String, default: null },
      companyName: { type: String, default: null, maxlength: 160 }
    },
    credits: {
      balance: { type: Number, default: 0, min: 0 },
      lifetimePurchased: { type: Number, default: 0, min: 0 },
      lifetimeUsed: { type: Number, default: 0, min: 0 }
    },
    integrations: {
      telegram: {
        chatId: { type: String, default: null },
        enabled: { type: Boolean, default: false },
        connectedAt: { type: Date, default: null }
      }
    },
    onboarding: {
      completed: { type: Boolean, default: false },
      currentStep: { type: String, default: 'account' },
      completedAt: { type: Date, default: null }
    },
    security: {
      lastLoginAt: { type: Date, default: null },
      passwordChangedAt: { type: Date, default: null },
      failedLoginAttempts: { type: Number, default: 0, min: 0 },
      lockedUntil: { type: Date, default: null }
    },
    payments: {
      questpay: [
        {
          reference: { type: String, default: null },
          amountNaira: { type: Number, default: 0 },
          tokenAmount: { type: Number, default: 0 },
          status: { type: String, default: 'pending' },
          paidAt: { type: Date, default: null }
        }
      ]
    },
    linkHistory: [
      {
        title: { type: String, default: '' },
        platform: { type: String, default: 'Instagram' },
        duration: { type: String, default: '1 week' },
        tokens: { type: Number, default: 1 },
        status: { type: String, default: 'pending_generation' },
        generatedUrl: { type: String, default: null },
        createdAt: { type: Date, default: Date.now },
        requestId: { type: String, default: null },
        respondedAt: { type: Date, default: null }
      }
    ]
  },
  { timestamps: true }
);

const configSchema = new mongoose.Schema(
  {
    key: { type: String, unique: true, required: true },
    value: { type: mongoose.Schema.Types.Mixed, default: null },
    description: { type: String, default: '' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);
module.exports.Config = mongoose.model('Config', configSchema);
