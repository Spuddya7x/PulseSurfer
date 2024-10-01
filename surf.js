const Position = require('./Position');
const bs58 = require('bs58');
const dotenv = require('dotenv');
const fs = require('fs');
const axios = require('axios');
const cheerio = require('cheerio');
const cliProgress = require('cli-progress');
const { Keypair, Connection, PublicKey, LAMPORTS_PER_SOL, VersionedTransaction, TransactionMessage, SystemProgram } = require('@solana/web3.js');
const { getAssociatedTokenAddress } = require("@solana/spl-token");
const { Wallet } = require('@project-serum/anchor');
const fetch = require('cross-fetch');
const os = require('os');
const WebSocket = require('ws');

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

const JitoBlockEngine = "https://mainnet.block-engine.jito.wtf/api/v1/bundles";
const TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT"
];
const getRandomTipAccount = () =>
  TIP_ACCOUNTS[Math.floor(Math.random() * TIP_ACCOUNTS.length)];

let { SENTIMENT_BOUNDARIES, SENTIMENT_MULTIPLIERS, INTERVAL } = readSettings();
const slippageBps = 200; // 5% slippage

const BASE_PRICE_URL = "https://price.jup.ag/v6/price?ids=";
const BASE_SWAP_URL = "https://quote-api.jup.ag/v6";

// Global variables
let position;
let keypair, connection;
let wallet;
let maxJitoTip = 0.00075,

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
    const privateKey = bs58.default.decode(process.env.PRIVATE_KEY);
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
  const settings = readSettings();
  const developerTipPercentage = settings.DEVELOPER_TIP_PERCENTAGE || 0; // Default to 0.2% if not set
  const totalFeePercentage = 0.05 + developerTipPercentage; // Minimum 0.05% + developer tip
  const platformFeeBps = Math.round(totalFeePercentage * 100); // Convert percentage to basis points

  const params = new URLSearchParams({
    inputMint: inputMint,
    outputMint: outputMint,
    amount: tradeAmountLamports.toString(),
    slippageBps: slippageBps.toString(),
    platformFeeBps: platformFeeBps.toString(),
    maxAutoSlippageBps: '500', // Maximum 5% slippage
    autoSlippage: 'true',
  });

  const quoteUrl = `${BASE_SWAP_URL}/quote?${params.toString()}`;

  try {
    const response = await fetch(quoteUrl);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const quoteResponse = await response.json();
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
      dynamicComputeUnitLimit: true
      //prioritizationFeeLamports: 'auto'
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

async function swapTokensWithRetry(
  connection,
  wallet,
  sentiment,
  BASE_SWAP_URL,
  USDC,
  SOL
) {
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 5000;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      console.log(`Swap attempt ${attempt + 1} of ${MAX_RETRIES}`);

      const latestPrice = await fetchPrice(BASE_PRICE_URL, SOL);
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

      const swapTransaction = await getFeeAccountAndSwapTransaction(
        new PublicKey("DGQRoyxV4Pi7yLnsVr1sT9YaRWN9WtwwcAiu3cKJsV9p"),
        new PublicKey(inputMint),
        quoteResponse,
        wallet
      );

      if (!swapTransaction) {
        throw new Error("Failed to get swap transaction");
      }

      const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
      const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

      // Use Jito bundling for the swap transaction
      const jitoBundleResult = await handleJitoBundle(transaction, wallet);
      console.log("Jito bundle sent, awaiting confirmation...");

      // Poll for balance changes
      const { solChange, usdcChange, newBalances } = await pollForBalanceChanges(wallet, preSwapBalances);

      const truePrice = Math.abs(usdcChange) / Math.abs(solChange);

      console.log(`Swap successful on attempt ${attempt + 1}`);
      console.log(`Transaction Details: https://solscan.io/tx/${jitoBundleResult.swapTxSignature}`);
      console.log(`True swap price: $${truePrice.toFixed(4)}`);
      console.log(`SOL change: ${solChange.toFixed(SOL.DECIMALS)} ${isBuying ? 'bought' : 'sold'}`);
      console.log(`USDC change: ${usdcChange.toFixed(USDC.DECIMALS)}`);

      return {
        txId: jitoBundleResult.swapTxSignature,
        price: truePrice,
        solChange,
        usdcChange,
        oldBalances: preSwapBalances,
        newBalances: newBalances,
        jitoBundleResult
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

async function jitoTipCheck() {
  const JitoTipWS = 'ws://bundles-api-rest.jito.wtf/api/v1/bundles/tip_stream';
  const tipws = new WebSocket(JitoTipWS);

  return new Promise((resolve, reject) => {
    tipws.on('open', function open() {
    });

    tipws.on('message', function incoming(data) {
      const str = data.toString();
      try {
        const json = JSON.parse(str);
        const emaPercentile50th = json[0].ema_landed_tips_50th_percentile;
        if (emaPercentile50th !== null) {
          tipws.close();
          resolve(emaPercentile50th);
        } else {
          reject(new Error('50th percentile is null'));
        }
      } catch (err) {
        reject(err);
      }
    });

    tipws.on('error', function error(err) {
      console.error('WebSocket error:', err);
      reject(err);
    });

    // Set a timeout
    setTimeout(() => {
      tipws.close();
      reject(new Error('Timeout'));
    }, 21000);
  });
}

async function handleJitoBundle(transaction, wallet) {

  // Check if the swap transaction is signed
  if (transaction.signatures[0].every(byte => byte === 0)) {
    try {
      transaction.sign([wallet.payer]);
    } catch (error) {
      console.error("Error signing swap transaction:", error);
      throw new Error("Failed to sign swap transaction in Jito Bundle");
    }
  } else {
    console.log("Swap transaction is already signed.");
  }

  let tipValueInSol;
  try {
    tipValueInSol = await jitoTipCheck();
  } catch (err) {
    console.error("Error in Jito tip check:", err);
    tipValueInSol = 0.00005; // Default value
    console.log(`Using default tip value: ${tipValueInSol} SOL`);
  }
  if (tipValueInSol > maxJitoTip) {
    tipValueInSol = maxJitoTip;
    console.log(`Tip value capped at max: ${tipValueInSol} SOL`);
  }
  const tipValueInLamports = tipValueInSol * 1_000_000_000;
  const roundedTipValueInLamports = Math.round(tipValueInLamports);

  // Limit to 9 digits and add 10% to edge out competition
  const limitedTipValueInLamports = Math.floor(
    Number(roundedTipValueInLamports.toFixed(9)) * 1.1
  );

  try {
    const tipAccount = new PublicKey(getRandomTipAccount());
    const tipIxn = SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: tipAccount,
      lamports: limitedTipValueInLamports
    });

    console.log(`Jito Fee: ${limitedTipValueInLamports / Math.pow(10, 9)} SOL`);

    const resp = await connection.getLatestBlockhash("confirmed");

    const messageSub = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: resp.blockhash,
      instructions: [tipIxn]
    }).compileToV0Message();

    const txSub = new VersionedTransaction(messageSub);
    txSub.sign([wallet.payer]);

    // Combine the swap transaction and the tip transaction
    const bundletoSend = [transaction, txSub];
    const jitoBundleResult = await sendJitoBundle(bundletoSend);
    console.log("Jito Bundle sent successfully");

    // Extract transaction signatures
    const swapTxSignature = bs58.default.encode(transaction.signatures[0]);
    const tipTxSignature = bs58.default.encode(txSub.signatures[0]);

    // Wait for transactions to be confirmed and fetch receipts
    const swapReceipt = await getTransactionReceipt(swapTxSignature);
    const tipReceipt = await getTransactionReceipt(tipTxSignature);

    return {
      jitoBundleResult,
      swapTxSignature,
      tipTxSignature,
      swapReceipt,
      tipReceipt
    };
  } catch (error) {
    console.error("\nBundle Construction Error: ", error);
    throw error;
  }
}

async function sendJitoBundle(bundletoSend) {
  let encodedBundle;
  try {
    encodedBundle = bundletoSend.map((tx, index) => {
      if (!(tx instanceof VersionedTransaction)) {
        throw new Error(`Transaction at index ${index} is not a VersionedTransaction`);
      }
      const serialized = tx.serialize();
      const encoded = bs58.default.encode(serialized);
      return encoded;
    });
  } catch (error) {
    console.error("Error encoding transactions:", error);
    throw error;
  }

  const data = {
    jsonrpc: "2.0",
    id: 1,
    method: "sendBundle",
    params: [encodedBundle]
  };

  console.log("Sending bundle to Jito Block Engine...");

  let response;
  const maxRetries = 5;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      response = await fetch(JitoBlockEngine, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(data)
      });

      if (response.ok) {
        break;
      }

      const responseText = await response.text();
      console.log(`Response status: ${response.status}`);
      console.log("Response body:", responseText);

      if (response.status === 400) {
        console.error("Bad Request Error. Response details:", responseText);
        throw new Error(`Bad Request: ${responseText}`);
      }

      if (response.status === 429) {
        const waitTime = Math.min(500 * Math.pow(2, i), 5000);
        const jitter = Math.random() * 0.3 * waitTime;
        console.log(`Rate limited. Retrying in ${waitTime + jitter}ms...`);
        await new Promise((resolve) => setTimeout(resolve, waitTime + jitter));
      } else {
        throw new Error(`Unexpected response status: ${response.status}`);
      }
    } catch (error) {
      console.error(`Error on attempt ${i + 1}:`, error);
      if (i === maxRetries) {
        console.error("Max retries exceeded");
        throw error;
      }
    }
  }

  if (!response.ok) {
    throw new Error(`Failed to send bundle after ${maxRetries} attempts`);
  }

  const responseText = await response.text();

  let responseData;
  try {
    responseData = JSON.parse(responseText);
  } catch (error) {
    console.error("Error parsing Jito response:", error);
    throw new Error("Failed to parse Jito response");
  }

  if (responseData.error) {
    console.error("Jito Block Engine returned an error:", responseData.error);
    throw new Error(`Jito error: ${responseData.error.message}`);
  }

  const result = responseData.result;
  if (!result) {
    console.error("No result in Jito response");
    throw new Error("No result in Jito response");
  }

  const url = `https://explorer.jito.wtf/bundle/${result}`;
  console.log(`\nJito Bundle Result: ${url}`);

  return result;
}

async function pollForBalanceChanges(wallet, preSwapBalances, maxAttempts = 30, interval = 2000) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const currentSolBalance = await getTokenBalance(connection, wallet.publicKey.toString(), SOL.ADDRESS);
    const currentUsdcBalance = await getTokenBalance(connection, wallet.publicKey.toString(), USDC.ADDRESS);

    const solChange = currentSolBalance - preSwapBalances.solBalance;
    const usdcChange = currentUsdcBalance - preSwapBalances.usdcBalance;

    if (Math.abs(solChange) > 0 && Math.abs(usdcChange) > 0) {
      console.log(`Balance changes detected after ${attempt + 1} attempts`);
      return {
        solChange,
        usdcChange,
        newBalances: { solBalance: currentSolBalance, usdcBalance: currentUsdcBalance }
      };
    }

    console.log(`Attempt ${attempt + 1}: No balance changes detected. Waiting ${interval / 1000} seconds...`);
    await new Promise(resolve => setTimeout(resolve, interval));
  }

  throw new Error("Failed to detect balance changes after maximum attempts");
}

async function getTransactionReceipt(signature) {
  const MAX_RETRIES = 30;
  const RETRY_DELAY = 1000; // 1 second

  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const confirmation = await connection.confirmTransaction(signature);
      if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${confirmation.value.err}`);
      }

      const txInfo = await connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
      });

      if (txInfo) {
        console.log(`Transaction ${signature} confirmed`);
        return {
          signature,
          slot: txInfo.slot,
          confirmations: txInfo.confirmations,
          err: txInfo.meta.err,
        };
      }
    } catch (error) {
      console.log(`Attempt ${i + 1}: Waiting for transaction confirmation...`);
    }

    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
  }

  throw new Error(`Failed to get receipt for transaction ${signature} after ${MAX_RETRIES} attempts`);
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

    console.log(`Jito Bundle ID: ${txId}`);

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

  console.log("Initialization complete. Starting trading operations with Jito integration.");
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