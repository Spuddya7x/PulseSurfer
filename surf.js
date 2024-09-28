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
const os = require('os');

// Load environment variables
function setupEnvFile() {
  const envPath = '.env';

  if (!fs.existsSync(envPath)) {
    console.log('.env file not found. Creating a new one...');

    const envContent = `PRIVATE_KEY=
RPC_URL=
ADMIN_PASSWORD=
PORT=3000
`;

    fs.writeFileSync(envPath, envContent);
    console.log('.env file created successfully. Please fill in your details.');
    process.exit(0);
  } else {
    console.log('.env file already exists.');
  }
}

setupEnvFile();
dotenv.config();
//Start server after .env control
const { server, paramUpdateEmitter, setInitialData, addRecentTrade, emitTradingData, readSettings } = require('./server');

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

let { SENTIMENT_BOUNDARIES, SENTIMENT_MULTIPLIERS, INTERVAL } = readSettings();
const slippageBps = 200; // 5% slippage

const BASE_PRICE_URL = "https://price.jup.ag/v6/price?ids=";
const BASE_SWAP_URL = "https://quote-api.jup.ag/v6";

// Global variables
let position;
let keypair, connection;
let wallet;

updateTradingScript = handleParameterUpdate;

//Create progressBar
const progressBar = new cliProgress.SingleBar({
  format: 'Progress |{bar}| {percentage}% | {remainingTime}',
  barCompleteChar: '\u2588',
  barIncompleteChar: '\u2591',
  hideCursor: true
});

function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const devName in interfaces) {
    const iface = interfaces[devName];
    for (let i = 0; i < iface.length; i++) {
      const alias = iface[i];
      if (alias.family === 'IPv4' && !alias.internal) {
        // Check for typical LAN IP ranges
        if (alias.address.startsWith('192.168.') ||
          alias.address.startsWith('10.') ||
          alias.address.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\./)) {
          return alias.address;
        }
      }
    }
  }
  return 'Unable to determine LAN IP address';
}

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

    //console.log(`Updated Portfolio Balances - SOL: ${solBalance.toFixed(SOL.DECIMALS)}, USDC: ${usdcBalance.toFixed(USDC.DECIMALS)}`);
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
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

  const weekday = days[now.getDay()];
  const day = String(now.getDate()).padStart(2, '0');
  const month = months[now.getMonth()];
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');

  return `${weekday}, ${day}/${month}, ${hours}:${minutes}:${seconds}`;
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
      //console.log(`${BASE_PRICE_URL}${tokenId}`);
      const response = await axios.get(`${BASE_PRICE_URL}${tokenId}`);
      const price = response.data.data[tokenId].price;
      //console.log(`Price fetched: $${price.toFixed(2)}`);
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
  const params = new URLSearchParams({
    inputMint: inputMint,
    outputMint: outputMint,
    amount: tradeAmountLamports.toString(),
    slippageBps: slippageBps.toString(),
    platformFeeBps: '25',
    maxAutoSlippageBps: '500', // Maximum 5% slippage
    autoSlippage: 'true',
    onlyDirectRoutes: 'true',
  });

  const quoteUrl = `${BASE_SWAP_URL}/quote?${params.toString()}`;
  //console.log(`Fetching quote from: ${quoteUrl}`);

  try {
    const response = await fetch(quoteUrl);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const quoteResponse = await response.json();
    //console.log(`Quote received:`, quoteResponse);
    return quoteResponse;
  } catch (error) {
    console.error('Error fetching quote:', error);
    throw error;
  }
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
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto'
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
    //console.log("Swap transaction with fee account obtained");
    return swapTransaction;
  } catch (error) {
    console.error("Failed to get fee account and swap transaction:", error);
    return null;
  }
}

async function executeAndConfirmTransaction(connection, transaction, wallet) {
  transaction.sign([wallet.payer]);
  const rawTransaction = transaction.serialize();
  const txId = await connection.sendRawTransaction(rawTransaction, {
    skipPreflight: true,
    maxRetries: 0
  });

  console.log(`Transaction sent: ${txId}`);

  try {
    let latestBlockHash = await connection.getLatestBlockhash('confirmed');
    const confirmation = await connection.confirmTransaction({
      blockhash: latestBlockHash.blockhash,
      lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
      signature: txId
    }, 'confirmed');

    if (confirmation.value.err) {
      throw new Error(`Transaction failed: ${confirmation.value.err}`);
    }

    //console.log(`Transaction confirmed`);
    return txId;
  } catch (error) {
    console.error(`Transaction confirmation failed: ${error.message}`);
    throw error; // Propagate the error to be caught in swapTokensWithRetry
  }
}

async function swapTokensWithRetry(
  connection,
  wallet,
  sentiment,
  BASE_SWAP_URL,
  USDC,
  SOL
) {
  const MAX_RETRIES = 3; // Limit the number of retries
  const RETRY_DELAY = 5000; // 5 seconds delay between retries
  const MAX_BALANCE_CHECK_ATTEMPTS = 5;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      console.log(`Swap attempt ${attempt + 1} of ${MAX_RETRIES}`);

      const latestPrice = await fetchPrice(BASE_PRICE_URL, SOL);

      // Get fresh "Pre-swap Balances"
      const preSwapBalances = await updatePortfolioBalances();

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

      console.log(`Current ${inputToken.NAME} balance: ${isBuying ? preSwapBalances.usdcBalance : preSwapBalances.solBalance}`);

      const tradeAmountLamports = calculateTradeAmount(
        isBuying ? preSwapBalances.usdcBalance : preSwapBalances.solBalance,
        sentiment,
        inputToken
      );
      console.log(`Attempting to swap ${(tradeAmountLamports / (10 ** inputToken.DECIMALS)).toFixed(inputToken.DECIMALS)} ${inputToken.NAME} for ${outputToken.NAME}...`);

      if (tradeAmountLamports <= 0) {
        console.log(`Insufficient balance for ${sentiment} operation`);
        return null;
      }

      const quoteResponse = await getQuote(BASE_SWAP_URL, inputMint, outputMint, tradeAmountLamports, slippageBps);

      const referralAccountPubkey = new PublicKey("7WGULgEo4Veqj6sCvA3VNxGgBf3EXJd8sW2XniBda3bJ");

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

      const txId = await executeAndConfirmTransaction(connection, transaction, wallet);

      console.log(`Swap transaction confirmed. Waiting 2s before checking balances...`);
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Get post-swap balances with retries
      let postSwapBalances;
      let solChange;
      let usdcChange;
      let balanceCheckAttempt = 0;

      while (balanceCheckAttempt < MAX_BALANCE_CHECK_ATTEMPTS) {
        postSwapBalances = await updatePortfolioBalances();
        solChange = postSwapBalances.solBalance - preSwapBalances.solBalance;
        usdcChange = postSwapBalances.usdcBalance - preSwapBalances.usdcBalance;

        if (Math.abs(solChange) > 0 && Math.abs(usdcChange) > 0) {
          break; // Both changes are non-zero, proceed with calculations
        }

        await new Promise(resolve => setTimeout(resolve, 2000));
        balanceCheckAttempt++;
      }

      if (Math.abs(solChange) === 0 || Math.abs(usdcChange) === 0) {
        throw new Error("Unable to detect balance changes after multiple attempts");
      }

      // Calculate the true price based on the actual amounts swapped
      const truePrice = Math.abs(usdcChange) / Math.abs(solChange);

      console.log(`Swap successful on attempt ${attempt + 1}`);
      console.log(`Transaction Details: https://solscan.io/tx/${txId}`);
      console.log(`True swap price: $${truePrice.toFixed(4)}`);
      console.log(`SOL change: ${solChange.toFixed(SOL.DECIMALS)} ${isBuying ? 'bought' : 'sold'}`);
      console.log(`USDC change: ${usdcChange.toFixed(USDC.DECIMALS)}`);

      return {
        txId,
        price: truePrice,
        solChange,
        usdcChange,
        oldBalances: preSwapBalances,
        newBalances: postSwapBalances
      };

    } catch (error) {
      console.error(`Error during swap attempt ${attempt + 1}:`, error);
      if (attempt < MAX_RETRIES - 1) {
        console.log(`Retrying swap in ${RETRY_DELAY / 1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      } else {
        console.error(`All ${MAX_RETRIES} swap attempts failed. Aborting swap.`);
        return null;
      }
    }
  }
}

function updatePositionFromSwap(swapResult, sentiment) {
  if (!swapResult) {
    console.log("No swap executed. Position remains unchanged.");
    return null;
  }

  const { price, solChange, usdcChange, txId } = swapResult;

  // Log the trade with the actual balance changes and true price
  position.logTrade(sentiment, price, solChange, usdcChange);

  //console.log(`Trade executed at price: $${price.toFixed(4)}`);
  //console.log(`SOL balance change: ${solChange.toFixed(SOL.DECIMALS)}`);
  //console.log(`USDC balance change: ${usdcChange.toFixed(USDC.DECIMALS)}`);

  logPositionUpdate(price);

  const tradeType = solChange > 0 ? "Bought" : "Sold";
  const tradeAmount = Math.abs(solChange);

  return {
    type: tradeType,
    amount: tradeAmount,
    price: price,
    timestamp: getRecentTradeTimestamp(),
    txUrl: `https://solscan.io/tx/${txId}`
  };
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
    console.clear();
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
    let txId = null;

    if (sentiment !== "NEUTRAL") {
      swapResult = await swapTokensWithRetry(
        connection,
        wallet,
        sentiment,
        BASE_SWAP_URL,
        USDC,
        SOL
      );

      if (swapResult) {
        txId = swapResult.txId;
        recentTrade = updatePositionFromSwap(swapResult, sentiment);
        if (recentTrade) {
          addRecentTrade(recentTrade);
          console.log(`${getTimestamp()}: ${recentTrade.type} ${recentTrade.amount.toFixed(6)} SOL at $${recentTrade.price.toFixed(2)}`);
        } else {
          console.log(`${getTimestamp()}: No trade executed this cycle.`);
        }
      }
    }
    const enhancedStats = position.getEnhancedStatistics(currentPrice);

    console.log("\n--- Enhanced Trading Statistics ---");
    console.log(`Total Script Runtime: ${enhancedStats.totalRuntime} hours`);
    console.log(`Total Cycles: ${enhancedStats.totalCycles}`);
    console.log(`Portfolio Value: $${enhancedStats.portfolioValue.initial} -> $${enhancedStats.portfolioValue.current} (${enhancedStats.portfolioValue.change >= 0 ? '+' : ''}${enhancedStats.portfolioValue.change}) (${enhancedStats.portfolioValue.percentageChange}%)`);
    console.log(`SOL Price: $${enhancedStats.solPrice.initial} -> $${enhancedStats.solPrice.current} (${enhancedStats.solPrice.percentageChange}%)`);
    console.log(`PnL: Realized: $${enhancedStats.pnl.realized}, Unrealized: $${enhancedStats.pnl.unrealized}, Total: $${enhancedStats.pnl.total}`);
    console.log(`Total Volume: ${enhancedStats.totalVolume.sol} SOL / ${enhancedStats.totalVolume.usdc} USDC ($${enhancedStats.totalVolume.usd})`);
    console.log(`Balances: SOL: ${enhancedStats.balances.sol.initial} -> ${enhancedStats.balances.sol.current}, USDC: ${enhancedStats.balances.usdc.initial} -> ${enhancedStats.balances.usdc.current}`);
    console.log(`Average Prices: Entry: $${enhancedStats.averagePrices.entry}, Sell: $${enhancedStats.averagePrices.sell}`);
    console.log("------------------------------------\n");

    console.log(txId);

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
      averageSellPrice: parseFloat(enhancedStats.averagePrices.sell) || 0,
      txId
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

function initializeCSV() {
  const headers = 'Timestamp,Price,FGIndex,Sentiment,USDCBalance,SOLBalance,PortfolioValue,AverageEntryPrice,RealizedPnL,UnrealizedPnL,TotalPnL\n';
  fs.writeFileSync('trading_data.csv', headers);
}

function handleParameterUpdate(newParams) {
  console.log('\n--- Parameter Update Received ---');
  console.log('New parameters:');
  console.log(JSON.stringify(newParams, null, 2));

  const updatedSettings = readSettings(); // Read the updated settings

  if (updatedSettings.SENTIMENT_BOUNDARIES) {
    SENTIMENT_BOUNDARIES = updatedSettings.SENTIMENT_BOUNDARIES;
    console.log('Sentiment boundaries updated. New boundaries:', SENTIMENT_BOUNDARIES);
  }
  if (updatedSettings.SENTIMENT_MULTIPLIERS) {
    SENTIMENT_MULTIPLIERS = updatedSettings.SENTIMENT_MULTIPLIERS;
    console.log('Sentiment multipliers updated. New multipliers:', SENTIMENT_MULTIPLIERS);
  }
  if (updatedSettings.INTERVAL) {
    INTERVAL = updatedSettings.INTERVAL;
    console.log('Interval updated. New interval:', INTERVAL);
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
 
  const settings = readSettings();
  SENTIMENT_BOUNDARIES = settings.SENTIMENT_BOUNDARIES;
  SENTIMENT_MULTIPLIERS = settings.SENTIMENT_MULTIPLIERS;
  INTERVAL = settings.INTERVAL;

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
  const localIpAddress = getLocalIpAddress();
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Your Local IP: http://${localIpAddress}:${PORT}`);
    console.log('Listening for parameter updates from web UI...');
  });
}

(async function () {
  initializeCSV();
  await initialize();
  await main();
})();