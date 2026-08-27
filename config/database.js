const dns = require('dns');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

dotenv.config();

dns.setServers([
  '1.1.1.1',
  '8.8.8.8',
  '9.9.9.9'
]);

const mongoUri = process.env.MONGODB_URI;

if (!mongoUri) throw new Error('MONGODB_URI is required');

async function connectDatabase() {
  await mongoose.connect(mongoUri, {
    maxPoolSize: 10,
    minPoolSize: 2,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000
  });
  console.log('MongoDB connected');
}

module.exports = { connectDatabase, mongoUri };
