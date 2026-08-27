const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const session = require('express-session');
const { MongoStore } = require('connect-mongo');
const { mongoUri } = require('../config/database');

const sessionSecret = process.env.SESSION_SECRET;
const secureCookies = process.env.COOKIE_SECURE === 'true';

if (!mongoUri) throw new Error('MONGODB_URI is required');
if (!sessionSecret) throw new Error('SESSION_SECRET is required');

function configureMiddleware(app) {
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(morgan('dev'));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      mongoUrl: mongoUri,
      mongoOptions: {
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000
      }
    }),
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookies,
      maxAge: 1000 * 60 * 60 * 24 * 7
    }
  }));
}

function requireAuth(request, response, next) {
  if (!request.session.userId) {
    return response.redirect('/login');
  }

  next();
}

module.exports = { configureMiddleware, requireAuth, mongoUri };
