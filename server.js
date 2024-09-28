const express = require('express');
const https = require('https');
const http = require('http');
const socketIo = require('socket.io');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require("express-rate-limit");
const dotenv = require('dotenv');
const cors = require('cors');
const session = require('express-session');

// Load environment variables
dotenv.config();

const app = express();

// Settings functionality
const SETTINGS_PATH = path.join(__dirname, 'settings.json');

const DEFAULT_SETTINGS = {
  SENTIMENT_BOUNDARIES: {
    EXTREME_FEAR: 15,
    FEAR: 35,
    GREED: 65,
    EXTREME_GREED: 85
  },
  SENTIMENT_MULTIPLIERS: {
    EXTREME_FEAR: 0.05,
    FEAR: 0.03,
    GREED: 0.03,
    EXTREME_GREED: 0.05
  },
  INTERVAL: 900000 // 15 minutes in milliseconds
};

function ensureSettingsFile() {
  if (!fs.existsSync(SETTINGS_PATH)) {
    console.log('settings.json not found. Creating with default values...');
    try {
      fs.writeFileSync(SETTINGS_PATH, JSON.stringify(DEFAULT_SETTINGS, null, 2));
      console.log('settings.json created successfully.');
    } catch (error) {
      console.error('Error creating settings.json:', error);
      process.exit(1);
    }
  }
}

function readSettings() {
  ensureSettingsFile();
  try {
    const settingsData = fs.readFileSync(SETTINGS_PATH, 'utf8');
    return JSON.parse(settingsData);
  } catch (error) {
    console.error('Error reading settings.json:', error);
    return DEFAULT_SETTINGS;
  }
}

function writeSettings(settings) {
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
    console.log('Settings updated successfully.');
  } catch (error) {
    console.error('Error writing settings.json:', error);
  }
}

function updateSettings(newSettings) {
  const currentSettings = readSettings();
  const updatedSettings = { ...currentSettings, ...newSettings };
  writeSettings(updatedSettings);
  return updatedSettings;
}

let tradingParams = readSettings();

// Middleware setup
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Use Helmet!
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'cdnjs.cloudflare.com'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'wss:', 'https:'],
      frameSrc: ["'self'", 'https://birdeye.so'],
      upgradeInsecureRequests: [],
    },
  }
}));

// Set up session
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // Set to true if using https
}));

// Set up rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// Check for ADMIN_PASSWORD
if (!process.env.ADMIN_PASSWORD) {
  console.error("ADMIN_PASSWORD is not set in the .env file. Please set it and restart the server.");
  process.exit(1);
}

// Server setup
let server;
if (fs.existsSync('/path/to/privkey.pem') && fs.existsSync('/path/to/cert.pem') && fs.existsSync('/path/to/chain.pem')) {
  const privateKey = fs.readFileSync('/path/to/privkey.pem', 'utf8');
  const certificate = fs.readFileSync('/path/to/cert.pem', 'utf8');
  const ca = fs.readFileSync('/path/to/chain.pem', 'utf8');

  const credentials = { key: privateKey, cert: certificate, ca: ca };
  server = https.createServer(credentials, app);
  console.log('HTTPS server created');
} else {
  server = http.createServer(app);
  console.log('HTTP server created. Consider setting up HTTPS for production use.');
}

const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// Authentication middleware
const authenticate = (req, res, next) => {
  if (req.session.authenticated) {
    next();
  } else {
    res.status(401).json({ error: 'Authentication required' });
  }
};

// Login route
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    req.session.authenticated = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

// Logout route
app.post('/api/logout', (req, res) => {
  req.session.authenticated = false;
  res.json({ success: true });
});

// Apply authentication to /api routes
app.use('/api', authenticate);

// Event emitter setup
const paramUpdateEmitter = new EventEmitter();

// Data storage
let initialData = null;
const recentTrades = [];
const MAX_RECENT_TRADES = 7;

function addRecentTrade(trade) {
  recentTrades.unshift(trade);
  if (recentTrades.length > MAX_RECENT_TRADES) {
    recentTrades.pop();
  }
}

// API routes
app.get('/api/initial-data', (req, res) => {
  const latestData = getLatestTradingData();
  if (latestData) {
    res.json(latestData);
  } else {
    res.status(503).json({ error: 'Initial data not yet available' });
  }
});

app.get('/api/params', (req, res) => {
  res.json(tradingParams);
});

app.get('/api/recent-trades', (req, res) => {
  res.json(recentTrades);
});

app.post('/api/params', (req, res) => {
  const newParams = req.body;
  tradingParams = updateSettings(newParams);
  io.emit('paramsUpdated', tradingParams);
  paramUpdateEmitter.emit('paramsUpdated', tradingParams);
  res.json({ message: 'Parameters updated successfully', params: tradingParams });
});

// Socket.io setup
io.on('connection', (socket) => {
  console.log('\nNew client connected');
  socket.on('disconnect', () => {
    console.log('\nClient disconnected');
  });
});

function getLatestTradingData() {
  if (!initialData) {
    return null;
  }
  return {
    ...initialData,
    recentTrades,
    averageEntryPrice: initialData.averageEntryPrice > 0 ? initialData.averageEntryPrice.toFixed(2) : 'N/A',
    averageSellPrice: initialData.averageSellPrice > 0 ? initialData.averageSellPrice.toFixed(2) : 'N/A',
    realizedPnL: initialData.realizedPnL.toFixed(3),
    unrealizedPnL: initialData.unrealizedPnL.toFixed(3),
    totalPnL: initialData.totalPnL.toFixed(3),
    portfolioValue: initialData.portfolioValue.toFixed(2),
    usdcBalance: initialData.usdcBalance.toFixed(2),
    solBalance: initialData.solBalance.toFixed(6),
    price: initialData.price.toFixed(2),
    txUrl: initialData.txUrl
  };
}

function emitTradingData(data) {
  const emitData = {
    timestamp: data.timestamp,
    price: (data.price).toFixed(2),
    fearGreedIndex: data.fearGreedIndex,
    sentiment: data.sentiment,
    usdcBalance: (data.usdcBalance).toFixed(2),
    solBalance: (data.solBalance).toFixed(6),
    portfolioValue: (data.portfolioValue).toFixed(2),
    realizedPnL: (data.realizedPnL).toFixed(3),
    unrealizedPnL: (data.unrealizedPnL).toFixed(3),
    totalPnL: (data.totalPnL).toFixed(3),
    averageEntryPrice: data.averageEntryPrice > 0 ? (data.averageEntryPrice).toFixed(2) : 'N/A',
    averageSellPrice: data.averageSellPrice > 0 ? (data.averageSellPrice).toFixed(2) : 'N/A',
    recentTrades: recentTrades,
    txId: data.txId || null,
    txUrl: data.txId ? `https://solscan.io/tx/${data.txId}` : null
  };
  console.log('Emitting trading data:', emitData);
  io.emit('tradingUpdate', emitData);

  // Update initialData with the latest data
  initialData = { ...data, recentTrades };
}

module.exports = {
  server,
  io,
  paramUpdateEmitter,
  setInitialData: (data) => {
    initialData = data;
  },
  addRecentTrade,
  emitTradingData,
  getLatestTradingData,
  readSettings
};