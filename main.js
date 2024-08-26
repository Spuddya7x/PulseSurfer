const { server, paramUpdateEmitter, setInitialData, addRecentTrade, emitTradingData } = require('./server');
const Position = require('./Position');
const bs58 = require('bs58');
const dotenv = require('dotenv');
const fs = require('fs');
const axios = require('axios');
const cheerio = require('cheerio');
const cliProgress = require('cli-progress');
const { Keypair, Connection, PublicKey, LAMPORTS_PER_SOL, VersionedTransaction } = require('@solana/web3.js');
const { getAssociatedTokenAddress } = require("@solana/spl-token");
//const { struct, u64 } = require('@project-serum/borsh');
const { Wallet } = require('@project-serum/anchor');
const fetch = require('cross-fetch');

// Load environment variables
dotenv.config();

// Constants
const USDC = {
  ADDRESS: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  DECIMALS: 6,
  NAME: "USDC"
};

const SOL = {
  NAME: "SOL",
  ADDRESS: "So11111111111111111111111111111111111111112",
  DECIMALS: 9,
  FULL_NAME: "solana"
};

// Easily editable sentiment boundaries
let SENTIMENT_BOUNDARIES = {
  EXTREME_FEAR: 20,  // 0-24: Extreme Fear
  FEAR: 40,          // 25-39: Fear
  //No Neutral Boundary - 40-59: Neutral
  GREED: 60,         // 60-74: Greed
  EXTREME_GREED: 80  // 75-100: Extreme Greed
};

// Easily editable sentiment multipliers (as percentages of portfolio)
let SENTIMENT_MULTIPLIERS = {
  EXTREME_FEAR: 0.03, // % of portfolio
  FEAR: 0.01,        // % of portfolio
  NEUTRAL: 0,        // No action
  GREED: 0.01,       // % of portfolio
  EXTREME_GREED: 0.03 // % of portfolio
};
const slippageBps = 200; // 2% slippage

let INTERVAL = 15 * 60 * 1000; // 15 minutes

const BASE_PRICE_URL = "https://price.jup.ag/v6/price?ids=";
const BASE_SWAP_URL = "https://quote-api.jup.ag/v6";

// Global variables
let position;
let keypair, connection;
let wallet;
let MAX_RETRIES = 5;
let RETRY_DELAY = 2000; // 2 seconds

updateTradingScript = handleParameterUpdate;

//Create progressBar
const progressBar = new cliProgress.SingleBar({
  format: 'Progress |{bar}| {percentage}% | {remainingTime}',
  barCompleteChar: '\u2588',
  barIncompleteChar: '\u2591',
  hideCursor: true
});

async function getTokenBalance(connection, walletAddress, mintAddress) {
  try {
    if (mintAddress === SOL.ADDRESS) {
      const balance = await connection.getBalance(new PublicKey(walletAddress));
      return balance / LAMPORTS_PER_SOL;
    } else {
      const tokenMint = new PublicKey(mintAddress);
      const walletPublicKey = new PublicKey(walletAddress);
      const tokenAddress = await getAssociatedTokenAddress(tokenMint, walletPublicKey);

      const balance = await connection.getTokenAccountBalance(tokenAddress);

      return parseFloat(balance.value.uiAmount);
    }
  } catch (error) {
    console.error("Error fetching token balance:", error);
    return 0;
  }
}

async function loadEnvironment() {
  if (!process.env.PRIVATE_KEY || !process.env.RPC_URL) {
    console.error("Missing required environment variables. Please ensure PRIVATE_KEY and RPC_URL are set in your .env file.");
    process.exit(1);
  }

  try {
    let privateKey;
    if (typeof bs58.decode === 'function') {
      privateKey = bs58.decode(process.env.PRIVATE_KEY);
    } else if (typeof bs58.default === 'object' && typeof bs58.default.decode === 'function') {
      privateKey = bs58.default.decode(process.env.PRIVATE_KEY);
    } else {
      throw new Error('bs58 decode function not found');
    }

    keypair = Keypair.fromSecretKey(new Uint8Array(privateKey));
    connection = new Connection(process.env.RPC_URL, 'confirmed');
    wallet = new Wallet(keypair);
    console.log("Keypair verified and RPC connection established.");
  } catch (error) {
    console.error("Error verifying keypair:", error.message);
    process.exit(1);
  }
}

async function checkBalance() {
  try {
    const solBalance = await connection.getBalance(keypair.publicKey);
    const usdcBalance = await getTokenBalance(connection, keypair.publicKey.toString(), USDC.ADDRESS);

    console.log(`SOL Balance: ${(solBalance / LAMPORTS_PER_SOL).toFixed(2)} SOL`);
    console.log(`USDC Balance: ${usdcBalance.toFixed(2)} USDC`);

    return { solBalance: solBalance / LAMPORTS_PER_SOL, usdcBalance };
  } catch (error) {
    console.error("Error checking balances:", error);
    return { solBalance: 0, usdcBalance: 0 };
  }
}

function initializeCSV() {
  const headers = 'Timestamp,Price,FGIndex,Sentiment,DollarBalance,TokenBalance,PortfolioValue,CostBasis,RealizedPnL,AverageBuyPrice,AverageSellPrice\n';
  fs.writeFileSync('trading_data.csv', headers);
}

function logData(timestamp, price, fearGreedIndex, sentiment, usdcBalance, tokenBalance, realizedPnL) {
  const portfolioValue = usdcBalance + tokenBalance * price;
  const averageBuyPrice = position.getAverageBuyPrice().toFixed(SOL.DECIMALS);
  const averageSellPrice = position.getAverageSellPrice().toFixed(SOL.DECIMALS);
  const data = `${timestamp},${price},${fearGreedIndex},${sentiment},${usdcBalance},${tokenBalance},${portfolioValue},${averageBuyPrice},${realizedPnL},${averageBuyPrice},${averageSellPrice}\n`;
  fs.appendFileSync('trading_data.csv', data);

  console.log(`FGI: ${fearGreedIndex} - ${sentiment}, Price: $${price}, Portfolio: $${portfolioValue.toFixed(2)}`);
}

async function fetchFearGreedIndex() {
  try {
    const response = await axios.get('https://cfgi.io/solana-fear-greed-index/15m');
    const html = response.data;
    const $ = cheerio.load(html);
    const scriptContent = $('script:contains("series:")').html();
    const seriesMatch = scriptContent.match(/series:\s*\[(\d+)\]/);

    if (seriesMatch) {
      const seriesNumber = parseInt(seriesMatch[1]);
      if (!isNaN(seriesNumber) && seriesNumber >= 0 && seriesNumber <= 100) {
        return seriesNumber;
      }
    }

    console.warn('Unable to parse Fear and Greed Index. Using default value.');
    return 50; // Default to neutral
  } catch (error) {
    console.error('Error fetching Fear and Greed Index:', error.message);
    return 50; // Default to neutral in case of error
  }
}

function getSentiment(data) {
  // Check if data is a valid number
  if (typeof data !== 'number' || isNaN(data)) {
    console.error(`Invalid Fear and Greed Index value: ${data}. Defaulting to NEUTRAL.`);
    return "NEUTRAL";
  }

  // Check if sentiment boundaries are properly defined
  const boundaries = Object.values(SENTIMENT_BOUNDARIES);
  if (!boundaries.every((value, index) => index === 0 || value > boundaries[index - 1])) {
    console.error("Sentiment boundaries are not properly defined. Defaulting to NEUTRAL.");
    return "NEUTRAL";
  }

  // Determine sentiment based on boundaries
  if (data < SENTIMENT_BOUNDARIES.EXTREME_FEAR) return "EXTREME_FEAR";
  if (data < SENTIMENT_BOUNDARIES.FEAR) return "FEAR";
  if (data < SENTIMENT_BOUNDARIES.GREED) return "NEUTRAL";
  if (data < SENTIMENT_BOUNDARIES.EXTREME_GREED) return "GREED";
  if (data <= 100) return "EXTREME_GREED";

  // If data is out of expected range (0-100), default to NEUTRAL
  console.error(`Fear and Greed Index value out of range: ${data}. Defaulting to NEUTRAL.`);
  return "NEUTRAL";
}

function getTimestamp() {
  const now = new Date();
  const formatOptions = { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
  return now.toLocaleString('en-US', formatOptions).replace(/,/g, ':');
}

function getRecentTradeTimestamp() {
  const now = new Date();
  return now.toISOString();
}

function formatTime(milliseconds) {
  const totalSeconds = Math.ceil(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function scheduleNextRun() {
  const now = new Date();
  const delay = INTERVAL - (now.getTime() % INTERVAL);
  console.log(`\nNext update in: ${formatTime(delay)}`);

  const totalSeconds = Math.ceil(delay / 1000);

  // Start the progress bar
  progressBar.start(totalSeconds, 0, {
    remainingTime: formatTime(delay)
  });

  let elapsedSeconds = 0;
  const updateInterval = setInterval(() => {
    elapsedSeconds++;
    const remainingSeconds = totalSeconds - elapsedSeconds;
    progressBar.update(elapsedSeconds, {
      remainingTime: formatTime(remainingSeconds * 1000)
    });

    if (elapsedSeconds >= totalSeconds) {
      clearInterval(updateInterval);
      progressBar.stop();
      main();
    }
  }, 1000);
}

async function fetchPrice(BASE_PRICE_URL, TOKEN, maxRetries = 5, retryDelay = 2000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios.get(`${BASE_PRICE_URL}${TOKEN.NAME}`);
      const price = response.data.data[TOKEN.NAME].price;
      return parseFloat(price.toFixed(TOKEN.DECIMALS));
    } catch (error) {
      console.error(`Error fetching price (attempt ${attempt}/${maxRetries}):`, error.message);

      if (attempt === maxRetries) {
        throw new Error(`Failed to fetch price after ${maxRetries} attempts`);
      }

      console.log(`Retrying in ${retryDelay / 1000} seconds...`);
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
}

function shouldSell(sentiment, currentPrice, averageEntryPrice) {
  const isSelling = ["GREED", "EXTREME_GREED"].includes(sentiment);
  if (!isSelling) {
    return false;
  }

  // Only sell if the current price is higher than the average entry price
  return currentPrice > averageEntryPrice || averageEntryPrice === 0 || isNaN(averageEntryPrice);
}

function calculateTradeAmount(balance, sentiment, tokenInfo) {
  const sentimentMultiplier = SENTIMENT_MULTIPLIERS[sentiment] || 0;
  const rawAmount = balance * sentimentMultiplier;
  return Math.floor(rawAmount * (10 ** tokenInfo.DECIMALS));
}

async function getQuote(BASE_SWAP_URL, inputMint, outputMint, tradeAmountLamports, slippageBps) {
  const quoteUrl = `${BASE_SWAP_URL}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${tradeAmountLamports}&slippageBps=${slippageBps}`;
  const quoteResponse = await (await fetch(quoteUrl)).json();
  return quoteResponse;
}

async function getSwapTransaction(BASE_SWAP_URL, quoteResponse, walletPublicKey) {
  const { swapTransaction } = await (
    await fetch(`${BASE_SWAP_URL}/swap`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: walletPublicKey,
        wrapUnwrapSol: true
        //feeAccount: "7WGULgEo4Veqj6sCvA3VNxGgBf3EXJd8sW2XniBda3bJ"
      })
    })
  ).json();
  return swapTransaction;
}

async function executeAndConfirmTransaction(connection, transaction, wallet) {
  transaction.sign([wallet.payer]);
  const rawTransaction = transaction.serialize();
  const txid = await connection.sendRawTransaction(rawTransaction, {
    skipPreflight: true,
    maxRetries: 3
  });

  console.log(`Transaction sent: ${txid}`);

  const MAX_RETRIES = 5;
  const RETRY_DELAY = 5000; // 5 seconds

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      let latestBlockHash = await connection.getLatestBlockhash('confirmed');
      const confirmation = await connection.confirmTransaction({
        blockhash: latestBlockHash.blockhash,
        lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
        signature: txid
      }, 'confirmed');

      if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${confirmation.value.err}`);
      }

      console.log(`Transaction confirmed after ${attempt + 1} attempt(s)`);
      return txid;
    } catch (error) {
      if (attempt === MAX_RETRIES - 1) {
        throw error;
      }
      console.log(`Confirmation attempt ${attempt + 1} failed, retrying in ${RETRY_DELAY / 1000} seconds...`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
    }
  }
}

async function swapTokensWithRetry(
  connection,
  wallet,
  sentiment,
  BASE_SWAP_URL,
  USDC,
  SOL,
) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      console.log(`Attempt ${attempt + 1} of ${MAX_RETRIES}`);

      // Fetch the latest price and balance before each attempt
      const latestPrice = await fetchPrice(BASE_PRICE_URL, SOL);
      const balance = await getTokenBalance(connection, wallet.publicKey.toString(),
        ["EXTREME_FEAR", "FEAR"].includes(sentiment) ? USDC.ADDRESS : SOL.ADDRESS
      );

      // Check if we should proceed with the swap
      if (sentiment === "NEUTRAL") {
        console.log("Neutral sentiment. No swap needed.");
        return null;
      }

      const isBuying = ["EXTREME_FEAR", "FEAR"].includes(sentiment);
      const averageEntryPrice = position.getAverageEntryPrice();

      if (!isBuying && !shouldSell(sentiment, latestPrice, averageEntryPrice)) {
        console.log(`Current price ($${latestPrice.toFixed(2)}) is below average entry price ($${averageEntryPrice.toFixed(2)}). Not selling.`);
        return null;
      }

      const inputMint = isBuying ? USDC.ADDRESS : SOL.ADDRESS;
      const outputMint = isBuying ? SOL.ADDRESS : USDC.ADDRESS;
      const inputToken = isBuying ? USDC : SOL;
      const outputToken = isBuying ? SOL : USDC;

      console.log(`Current ${inputToken.NAME} balance: ${balance}`);

      const tradeAmountLamports = calculateTradeAmount(balance, sentiment, inputToken);
      console.log(`Attempting to swap ${(tradeAmountLamports / (10 ** inputToken.DECIMALS)).toFixed(inputToken.DECIMALS)} ${inputToken.NAME} for ${outputToken.NAME}...`);

      if (tradeAmountLamports <= 0) {
        console.log(`Insufficient balance for ${sentiment} operation`);
        return null;
      }

      // Get a new quote for each attempt
      const quoteResponse = await getQuote(BASE_SWAP_URL, inputMint, outputMint, tradeAmountLamports, slippageBps);
      const swapTransaction = await getSwapTransaction(BASE_SWAP_URL, quoteResponse, wallet.publicKey.toString());

      const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
      const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

      const txid = await executeAndConfirmTransaction(connection, transaction, wallet);

      // Fetch the transaction details
      const txInfo = await connection.getTransaction(txid, { maxSupportedTransactionVersion: 0 });

      if (!txInfo) {
        throw new Error('Transaction info not found');
      }

      // Parse the transaction to get the exact amounts
      const { inputAmount, outputAmount } = parseJupiterSwapTransaction(txInfo, inputMint, outputMint);

      const inputAmountUI = inputAmount / (10 ** inputToken.DECIMALS);
      const outputAmountUI = outputAmount / (10 ** outputToken.DECIMALS);
      const percentTraded = (inputAmountUI / balance) * 100;

      console.log(`Swap successful on attempt ${attempt + 1}`);
      if (isBuying) {
        console.log(`Bought ${outputAmountUI.toFixed(SOL.DECIMALS)} SOL for ${inputAmountUI.toFixed(USDC.DECIMALS)} USDC at price $${latestPrice.toFixed(2)}`);
      } else {
        console.log(`Sold ${inputAmountUI.toFixed(SOL.DECIMALS)} SOL for ${outputAmountUI.toFixed(USDC.DECIMALS)} USDC at price $${latestPrice.toFixed(2)}`);
      }
      console.log(`(${percentTraded.toFixed(2)}% of ${inputToken.NAME} balance)`);
      console.log(`Transaction Details: https://solscan.io/tx/${txid}`);

      return {
        txid,
        inputAmount: inputAmountUI,
        outputAmount: outputAmountUI,
        isBuying,
        price: latestPrice
      };

    } catch (error) {
      console.error(`Error during swap attempt ${attempt + 1}:`, error);
      if (attempt < MAX_RETRIES - 1) {
        console.log(`Retrying in ${RETRY_DELAY / 1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      } else {
        console.error(`All ${MAX_RETRIES} attempts failed. Aborting swap.`);
        return null;
      }
    }
  }
}

function parseJupiterSwapTransaction(txInfo, inputMint, outputMint) {
  const postTokenBalances = txInfo.meta.postTokenBalances;
  const preTokenBalances = txInfo.meta.preTokenBalances;

  let inputAmount = 0;
  let outputAmount = 0;

  for (let i = 0; i < postTokenBalances.length; i++) {
    const post = postTokenBalances[i];
    const pre = preTokenBalances[i];

    if (post.mint === inputMint) {
      inputAmount = Math.abs(parseInt(pre.uiTokenAmount.amount) - parseInt(post.uiTokenAmount.amount));
    } else if (post.mint === outputMint) {
      outputAmount = Math.abs(parseInt(post.uiTokenAmount.amount) - parseInt(pre.uiTokenAmount.amount));
    }
  }

  return { inputAmount, outputAmount };
}

function updatePositionFromSwap(swapResult, sentiment) {
  if (!swapResult) {
    console.log("No swap executed. Position remains unchanged.");
    return;
  }

  const { inputAmount, outputAmount, price, isBuying } = swapResult;

  if (isBuying) {
    position.addTrade('buy', outputAmount, inputAmount, price);
    console.log(`Bought ${outputAmount.toFixed(SOL.DECIMALS)} SOL at $${price.toFixed(2)} for ${inputAmount.toFixed(USDC.DECIMALS)} USDC`);
  } else {
    position.addTrade('sell', inputAmount, outputAmount, price);
    console.log(`Sold ${inputAmount.toFixed(SOL.DECIMALS)} SOL at $${price.toFixed(2)} for ${outputAmount.toFixed(USDC.DECIMALS)} USDC`);
  }

  logPositionUpdate(price);
}

function logPositionUpdate(currentPrice) {
  console.log("\n--- Current Position ---");
  console.log(`SOL Balance: ${position.solBalance.toFixed(SOL.DECIMALS)} SOL`);
  console.log(`USDC Balance: ${position.usdcBalance.toFixed(USDC.DECIMALS)} USDC`);
  console.log(`Average Entry Price: $${position.getAverageEntryPrice().toFixed(2)}`);
  console.log(`Average Sell Price: $${position.getAverageSellPrice().toFixed(2)}`);
  console.log(`Unrealized P&L: $${position.getUnrealizedPnL(currentPrice).toFixed(2)}`);
  console.log(`Realized P&L: $${position.getRealizedPnL().toFixed(2)}`);
  console.log(`Total P&L: $${position.getTotalPnL(currentPrice).toFixed(2)}`);
  console.log("------------------------\n");
}

async function main() {
  try {
    const fearGreedIndex = await fetchFearGreedIndex();
    const sentiment = getSentiment(fearGreedIndex);
    const currentPrice = await fetchPrice(BASE_PRICE_URL, SOL);
    const timestamp = getTimestamp();
    //console.clear();
    console.log(`\n--- Trading Cycle: ${timestamp} ---`);
    console.log(`Fear & Greed Index: ${fearGreedIndex} - Sentiment: ${sentiment}`);
    console.log(`Current SOL Price: $${currentPrice.toFixed(2)}`);

    let swapResult = null;
    let recentTrade = null;

    if (sentiment !== "NEUTRAL") {
      swapResult = await swapTokensWithRetry(
        connection,
        wallet,
        sentiment,
        BASE_SWAP_URL,
        USDC,
        SOL,
        currentPrice
      );

      if (swapResult) {
        updatePositionFromSwap(swapResult, sentiment, currentPrice);
        // Create recentTrade object with a consistent structure
        recentTrade = {
          type: swapResult.isBuying ? "Bought" : "Sold",
          amount: swapResult.isBuying ? swapResult.outputAmount : swapResult.inputAmount,
          price: currentPrice,
          timestamp: getRecentTradeTimestamp()
        };
      }
    }

    if (recentTrade) {
      addRecentTrade(recentTrade); // Add the trade to the recent trades list
      console.log("Trade executed:", recentTrade);
    } else {
      console.log("No trade executed this cycle.");
    }

    const portfolioValue = position.usdcBalance + position.solBalance * currentPrice;

    logData(timestamp, currentPrice, fearGreedIndex, sentiment, position.usdcBalance, position.solBalance, position.getRealizedPnL(), position.getUnrealizedPnL(currentPrice), position.getTotalPnL(currentPrice));

    await checkBalance();

    let totalPnL = position.getTotalPnL(currentPrice);
    let unrealizedPnL = position.getUnrealizedPnL(currentPrice);
    let realizedPnL = position.getRealizedPnL();

    let tradingData = {
      timestamp,
      price: currentPrice,
      fearGreedIndex,
      sentiment,
      usdcBalance: position.usdcBalance,
      solBalance: position.solBalance,
      portfolioValue,
      realizedPnL: realizedPnL,
      unrealizedPnL: unrealizedPnL,
      totalPnL: totalPnL,
      averageEntryPrice: position.getAverageEntryPrice(),
      averageSellPrice: position.getAverageSellPrice()
    };

    emitTradingData(tradingData); // This will now include recent trades from the server

    scheduleNextRun();
  } catch (error) {
    console.error('Error during main execution:', error);
    // Stop the progress bar if it's running
    if (progressBar) {
      progressBar.stop();
    }
    // Reschedule the next run
    scheduleNextRun();
  }
}

function logData(timestamp, price, fearGreedIndex, sentiment, usdcBalance, solBalance, realizedPnL, unrealizedPnL, totalPnL) {
  const portfolioValue = usdcBalance + solBalance * price;
  const data = `${timestamp},${price},${fearGreedIndex},${sentiment},${usdcBalance},${solBalance},${portfolioValue},${position.getAverageEntryPrice()},${realizedPnL},${unrealizedPnL},${totalPnL}\n`;
  fs.appendFileSync('trading_data.csv', data);

  console.log(`FGI: ${fearGreedIndex} - ${sentiment}, Price: $${price}, Portfolio: $${portfolioValue.toFixed(2)}`);
}

function initializeCSV() {
  const headers = 'Timestamp,Price,FGIndex,Sentiment,USDCBalance,SOLBalance,PortfolioValue,AverageEntryPrice,RealizedPnL,UnrealizedPnL,TotalPnL\n';
  fs.writeFileSync('trading_data.csv', headers);
}

function handleParameterUpdate(newParams) {
  console.log('\n--- Parameter Update Received ---');
  console.log('New parameters:');
  console.log(JSON.stringify(newParams, null, 2));

  if (newParams.SENTIMENT_BOUNDARIES) {
    Object.keys(newParams.SENTIMENT_BOUNDARIES).forEach(key => {
      SENTIMENT_BOUNDARIES[key] = newParams.SENTIMENT_BOUNDARIES[key];
    });
    console.log('Sentiment boundaries updated. New boundaries:', SENTIMENT_BOUNDARIES);
  }
  if (newParams.SENTIMENT_MULTIPLIERS) {
    Object.keys(newParams.SENTIMENT_MULTIPLIERS).forEach(key => {
      SENTIMENT_MULTIPLIERS[key] = newParams.SENTIMENT_MULTIPLIERS[key];
    });
    console.log('Sentiment multipliers updated. New multipliers:', SENTIMENT_MULTIPLIERS);
  }

  console.log('Trading strategy will adjust in the next cycle.');
  console.log('----------------------------------\n');
}

paramUpdateEmitter.on('paramsUpdated', handleParameterUpdate);

async function initialize() {
  await loadEnvironment();
  const { solBalance, usdcBalance } = await checkBalance();
  const currentPrice = await fetchPrice(BASE_PRICE_URL, SOL);
  position = new Position(solBalance, usdcBalance, currentPrice);
  isInitialized = true;
  console.log("Initialization complete. Starting trading operations.");
  console.log(`Initial position: ${solBalance.toFixed(SOL.DECIMALS)} ${SOL.NAME}, ${usdcBalance.toFixed(USDC.DECIMALS)} USDC`);
  console.log(`Initial SOL price: $${currentPrice.toFixed(2)}`);
  console.log(`Initial portfolio value: $${position.getCurrentValue(currentPrice).toFixed(2)}`);

  const initialData = {
    timestamp: getTimestamp(),
    price: currentPrice,
    fearGreedIndex: await fetchFearGreedIndex(),
    sentiment: getSentiment(await fetchFearGreedIndex()),
    usdcBalance: position.usdcBalance,
    solBalance: position.solBalance,
    portfolioValue: position.getCurrentValue(currentPrice),
    realizedPnL: position.getRealizedPnL(),
    unrealizedPnL: position.getUnrealizedPnL(currentPrice),
    totalPnL: position.getTotalPnL(currentPrice),
    averageEntryPrice: position.getAverageEntryPrice(),
    averageSellPrice: position.getAverageSellPrice()
  };

  setInitialData(initialData);
  emitTradingData(initialData);

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log('Listening for parameter updates from web UI...');
  });
}

(async function () {
  initializeCSV();
  await initialize();
  await main();
})();