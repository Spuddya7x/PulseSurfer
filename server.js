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

// Read settings from JSON file
function readSettings() {
  const settingsPath = path.join(__dirname, 'settings.json');
  const settingsData = fs.readFileSync(settingsPath, 'utf8');
  return JSON.parse(settingsData);
}

// Write settings to JSON file
function writeSettings(settings) {
  const settingsPath = path.join(__dirname, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

let tradingParams = readSettings();

function addRecentTrade(trade) {
  recentTrades.unshift(trade);
  if (recentTrades.length > MAX_RECENT_TRADES) {
    recentTrades.pop();
  }
}

// API routes
app.get('/api/initial-data', (req, res) => {
  if (initialData) {
    res.json({ ...initialData, recentTrades });
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
  tradingParams = { ...tradingParams, ...newParams };
  writeSettings(tradingParams);
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
  readSettings
};