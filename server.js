const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const EventEmitter = require('events');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Serve static files from the 'public' directory
app.use(express.static('public'));

// Parse JSON payloads
app.use(express.json());

// Event emitter to notify when parameters are updated
const paramUpdateEmitter = new EventEmitter();

// Global variables to store current parameters and initial data
let initialData = null;
const recentTrades = [];
const MAX_RECENT_TRADES = 7;


let tradingParams = {
  SENTIMENT_BOUNDARIES: {
    EXTREME_FEAR: 20,
    FEAR: 40,
    GREED: 60,
    EXTREME_GREED: 80
  },
  SENTIMENT_MULTIPLIERS: {
    EXTREME_FEAR: 0.03,
    FEAR: 0.01,
    NEUTRAL: 0,
    GREED: 0.01,
    EXTREME_GREED: 0.03
  },
  INTERVAL: 15 * 60 * 1000
};

// Function to add a recent trade
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
  // Update parameters (add validation as needed)
  tradingParams = { ...tradingParams, ...newParams };
  io.emit('paramsUpdated', tradingParams);

  // Emit an event for the main script
  paramUpdateEmitter.emit('paramsUpdated', tradingParams);

  res.json({ message: 'Parameters updated successfully', params: tradingParams });
});

// WebSocket server
io.on('connection', (socket) => {
  console.log('\nNew client connected');
  socket.on('disconnect', () => {
    console.log('\nClient disconnected');
  });
});

// Function to emit trading data
function emitTradingData(data) {
  //console.log('\nEmitting trading data');
  //console.log(data);

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
    recentTrades: recentTrades
  };

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
  emitTradingData
};