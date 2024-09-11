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
  EXTREME_FEAR: 21,  // 0-24: Extreme Fear
  FEAR: 31,          // 25-39: Fear
  //No Neutral Boundary - 40-59: Neutral
  GREED: 61,         // 60-74: Greed
  EXTREME_GREED: 87  // 75-100: Extreme Greed
};

// Easily editable sentiment multipliers (as percentages of portfolio)
let SENTIMENT_MULTIPLIERS = {
  EXTREME_FEAR: 0.035, // % of portfolio
  FEAR: 0.0012,        // % of portfolio
  NEUTRAL: 0,        // No action
  GREED: 0.0201,       // % of portfolio
  EXTREME_GREED: 0.0737 // % of portfolio
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
let startTime = Date.now();
let totalCycles = 0;
let startingPortfolioValue = 0;
let totalExtremeFearBuys = 0;
let totalFearBuys = 0;
let totalGreedSells = 0;
let totalExtremeGreedSells = 0;
let totalVolumeSol = 0;
let totalVolumeUsdc = 0;

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

async function updatePortfolioBalances() {
  try {
    const solBalance = await getTokenBalance(connection, wallet.publicKey.toString(), SOL.ADDRESS);
    const usdcBalance = await getTokenBalance(connection, wallet.publicKey.toString(), USDC.ADDRESS);

    // Update the position with new balances
    position.updateBalances(solBalance, usdcBalance);

    console.log(`Updated Portfolio Balances - SOL: ${solBalance.toFixed(SOL.DECIMALS)}, USDC: ${usdcBalance.toFixed(USDC.DECIMALS)}`);
    return { solBalance, usdcBalance };
  } catch (error) {
    console.error("Error updating portfolio balances:", error);
    throw error;
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

async function fetchPrice(BASE_PRICE_URL, TOKEN, maxRetries = 5, retryDelay = 5000) {
  const tokenId = 'So11111111111111111111111111111111111111112';

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`${BASE_PRICE_URL}${tokenId}`);
      const response = await axios.get(`${BASE_PRICE_URL}${tokenId}`);
      const price = response.data.data[tokenId].price;
      console.log(`Price fetched: $${price.toFixed(2)}`);
      return parseFloat(price.toFixed(2));
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
  const quoteUrl = `${BASE_SWAP_URL}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${tradeAmountLamports}&slippageBps=${slippageBps}&platformFeeBps=25`;
  const quoteResponse = await (await fetch(quoteUrl)).json();
  return quoteResponse;
}

async function getFeeAccountAndSwapTransaction(
  referralAccountPubkey,
  mint,
  quoteResponse,
  wallet
) {
  try {
    const [feeAccount] = await PublicKey.findProgramAddressSync(
      [
        Buffer.from("referral_ata"),
        referralAccountPubkey.toBuffer(),
        mint.toBuffer(),
      ],
      new PublicKey("REFER4ZgmyYx9c6He5XfaTMiGfdLwRnkV4RPp9t9iF3")
    );

    const requestBody = {
      quoteResponse,
      userPublicKey: wallet.publicKey.toString(),
      wrapAndUnwrapSol: true,
      feeAccount: feeAccount.toString(),
    };

    const response = await fetch("https://quote-api.jup.ag/v6/swap", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      throw new Error(`Error performing swap: ${response.statusText}`);
    }

    const { swapTransaction } = await response.json();
    console.log("Swap transaction with fee account obtained");
    return swapTransaction;
  } catch (error) {
    console.error("Failed to get fee account and swap transaction:", error);
    return null;
  }
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
  const RETRY_DELAY = 2000; // 2 seconds

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
      const { solBalance, usdcBalance } = await updatePortfolioBalances();

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

      console.log(`Current ${inputToken.NAME} balance: ${isBuying ? usdcBalance : solBalance}`);

      const tradeAmountLamports = calculateTradeAmount(isBuying ? usdcBalance : solBalance, sentiment, inputToken);
      console.log(`Attempting to swap ${(tradeAmountLamports / (10 ** inputToken.DECIMALS)).toFixed(inputToken.DECIMALS)} ${inputToken.NAME} for ${outputToken.NAME}...`);

      if (tradeAmountLamports <= 0) {
        console.log(`Insufficient balance for ${sentiment} operation`);
        return null;
      }

      // Get a new quote for each attempt
      const quoteResponse = await getQuote(BASE_SWAP_URL, inputMint, outputMint, tradeAmountLamports, slippageBps);

      // Define the referral account public key
      const referralAccountPubkey = new PublicKey("7WGULgEo4Veqj6sCvA3VNxGgBf3EXJd8sW2XniBda3bJ");

      // Get the swap transaction with fee account
      const swapTransaction = await getFeeAccountAndSwapTransaction(
        referralAccountPubkey,
        new PublicKey(inputMint),
        quoteResponse,
        wallet
      );

      if (!swapTransaction) {
        throw new Error("Failed to get swap transaction");
      }

      const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
      const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

      const txid = await executeAndConfirmTransaction(connection, transaction, wallet);

      // Immediately update portfolio balances after successful swap
      const newBalances = await updatePortfolioBalances();

      console.log(`Swap successful on attempt ${attempt + 1}`);
      console.log(`Transaction Details: https://solscan.io/tx/${txid}`);

      return {
        txid,
        price: latestPrice,
        oldBalances: { solBalance, usdcBalance },
        newBalances
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

  const { price, oldBalances, newBalances } = swapResult;

  // Calculate the changes in balances
  const solChange = newBalances.solBalance - oldBalances.solBalance;
  const usdcChange = newBalances.usdcBalance - oldBalances.usdcBalance;

  // Log the trade with the actual balance changes
  position.logTrade(sentiment, price, solChange, usdcChange);

  console.log(`Trade executed at $${price.toFixed(2)}`);
  console.log(`SOL balance change: ${solChange.toFixed(SOL.DECIMALS)}`);
  console.log(`USDC balance change: ${usdcChange.toFixed(USDC.DECIMALS)}`);

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
    position.incrementCycle();

    const fearGreedIndex = await fetchFearGreedIndex();
    const sentiment = getSentiment(fearGreedIndex);
    const currentPrice = await fetchPrice(BASE_PRICE_URL, SOL);
    const timestamp = getTimestamp();

    console.log(`\n--- Trading Cycle: ${timestamp} ---`);
    console.log(`Fear & Greed Index: ${fearGreedIndex} - Sentiment: ${sentiment}`);
    console.log(`Current SOL Price: $${currentPrice.toFixed(2)}`);

    // Update portfolio balances at the start of each cycle
    await updatePortfolioBalances();

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
        updatePositionFromSwap(swapResult, sentiment);
        const tradeAmount = Math.abs(swapResult.newBalances.solBalance - swapResult.oldBalances.solBalance);
        recentTrade = {
          type: sentiment === "EXTREME_FEAR" || sentiment === "FEAR" ? "Bought" : "Sold",
          amount: tradeAmount,
          price: currentPrice,
          timestamp: getRecentTradeTimestamp()
        };
      }
    }

    if (recentTrade) {
      addRecentTrade(recentTrade);
      console.log("Trade executed:", recentTrade);
    } else {
      console.log("No trade executed this cycle.");
    }

    const enhancedStats = position.getEnhancedStatistics(currentPrice);

    console.log("\n--- Enhanced Trading Statistics ---");
    console.log(`Total Script Runtime: ${enhancedStats.totalRuntime} hours`);
    console.log(`Total Cycles: ${enhancedStats.totalCycles}`);
    console.log(`Portfolio Value: $${enhancedStats.portfolioValue.initial} -> $${enhancedStats.portfolioValue.current} (${enhancedStats.portfolioValue.change >= 0 ? '+' : ''}${enhancedStats.portfolioValue.change}) (${enhancedStats.portfolioValue.percentageChange}%)`);
    console.log(`SOL Price: $${enhancedStats.solPrice.initial} -> $${enhancedStats.solPrice.current} (${enhancedStats.solPrice.percentageChange}%)`);
    console.log(`PnL: Realized: $${enhancedStats.pnl.realized}, Unrealized: $${enhancedStats.pnl.unrealized}, Total: $${enhancedStats.pnl.total}`);
    console.log(`Total Extreme Fear Buys: ${enhancedStats.extremeFearBuys} SOL`);
    console.log(`Total Fear Buys: ${enhancedStats.fearBuys} SOL`);
    console.log(`Total Greed Sells: ${enhancedStats.greedSells} SOL`);
    console.log(`Total Extreme Greed Sells: ${enhancedStats.extremeGreedSells} SOL`);
    console.log(`Total Volume: ${enhancedStats.totalVolume.sol} SOL / ${enhancedStats.totalVolume.usdc} USDC ($${enhancedStats.totalVolume.usd})`);
    console.log(`Balances: SOL: ${enhancedStats.balances.sol.initial} -> ${enhancedStats.balances.sol.current}, USDC: ${enhancedStats.balances.usdc.initial} -> ${enhancedStats.balances.usdc.current}`);
    console.log(`Average Prices: Entry: $${enhancedStats.averagePrices.entry}, Sell: $${enhancedStats.averagePrices.sell}`);
    console.log("------------------------------------\n");

    let tradingData = {
      timestamp,
      price: currentPrice,
      fearGreedIndex,
      sentiment,
      usdcBalance: position.usdcBalance,
      solBalance: position.solBalance,
      portfolioValue: parseFloat(enhancedStats.portfolioValue.current),
      realizedPnL: parseFloat(enhancedStats.pnl.realized),
      unrealizedPnL: parseFloat(enhancedStats.pnl.unrealized),
      totalPnL: parseFloat(enhancedStats.pnl.total),
      averageEntryPrice: parseFloat(enhancedStats.averagePrices.entry) || 0,
      averageSellPrice: parseFloat(enhancedStats.averagePrices.sell) || 0
    };

    emitTradingData(tradingData);

    scheduleNextRun();
  } catch (error) {
    console.error('Error during main execution:', error);
    if (progressBar) {
      progressBar.stop();
    }
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