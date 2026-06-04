import dotenv from 'dotenv';
import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import bs58 from 'bs58';
import { Connection, Keypair } from '@solana/web3.js';
import CONFIG from '../config.js';
import Discovery from './discovery.js';
import Scanner from './scanner.js';
import { filterCandidate } from './filter.js';
import { isTokenSafe } from './filters/rugCheck.js';
import { getGeminiBudgetStatus, scoreCandidate } from './scorer.js';
import Executor from './executor.js';
import Monitor from './monitor.js';
import RemoteBridge from './remoteBridge.js';
import { getDailyPnl, getTradesByMint, insertTrade } from './db.js';
import logger from './logger.js';
import { callRpc } from './rpcClient.js';
import {
  canOpenPosition,
  getStateSnapshot,
  isDailyLimitBreached,
  openPosition as openStatePosition
} from './state.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

let isScanning = false;
let isDiscoveryProcessing = false;
let shuttingDown = false;
let scanInterval = null;
let server = null;
let discovery = null;
let remoteBridge = null;
let usingTemporarySimulationWallet = false;
const aiDecisionCache = new Map();
const scanActivityLog = [];
const SCAN_ACTIVITY_LOG_LIMIT = 100;
const botState = {
  paused: false,
  lastControlAction: 'started',
  lastControlSource: 'local',
  updatedAt: Date.now()
};

async function main() {
  try {
    process.on('unhandledRejection', (reason) => {
      try {
        logger.error('[index] Unhandled promise rejection caught:', { reason });
      } catch (error) {
        logger.error('[index] Failed to log unhandled rejection:', { error: error.message });
      }
    });

    process.on('uncaughtException', (error) => {
      try {
        logger.error('[index] Uncaught exception caught:', { error: error.message });
      } catch (handlerError) {
        logger.error('[index] Failed to log uncaught exception:', { error: handlerError.message });
      }
    });

    const connection = new Connection(CONFIG.PRIMARY_RPC_URL, 'confirmed');
    const wallet = loadWallet();
    const balanceLamports = await getStartupBalance(wallet);

    logger.info(`[startup] Wallet: ${wallet.publicKey.toBase58()}`);
    logger.info(`[startup] SOL balance: ${(balanceLamports / 1e9).toFixed(6)} SOL`);
    logger.info(`[startup] Simulation mode: ${CONFIG.SIMULATION_MODE ? 'ON' : 'OFF'}`);

    const scanner = new Scanner();
    const executor = new Executor(connection, wallet);
    const monitor = new Monitor(executor, connection);
    monitor.start();

    server = startDashboardServer(monitor, wallet);
    remoteBridge = startRemoteBridge(monitor, wallet);

    const runScan = async () => {
      try {
        if (isScanning || shuttingDown || botState.paused) return;
        isScanning = true;
        await scanAndTrade(scanner, monitor, executor);
      } catch (error) {
        logger.error('[index] Scan loop failed:', { error: error.message });
      } finally {
        isScanning = false;
      }
    };

    if (CONFIG.HELIUS_API_KEY && !CONFIG.SIMULATION_MODE) {
      discovery = new Discovery({
        onCandidate: (candidate) => processDiscoveryCandidate(candidate, monitor, executor)
      });
      discovery.start();
      logger.info('[startup] Helius Raydium discovery enabled; DexScreener polling is disabled.');
    } else {
      if (CONFIG.HELIUS_API_KEY && CONFIG.SIMULATION_MODE) {
        logger.info('[startup] Simulation mode active; skipping Helius RPC subscription and using DexScreener polling.');
      }
      scanner.startOptionalWebSocketFeed();
      await runScan();
      scanInterval = setInterval(() => {
        try {
          runScan().catch((error) => {
            logger.error('[index] Scheduled scan promise failed:', { error: error.message });
          });
        } catch (error) {
          logger.error('[index] Scheduled scan failed:', { error: error.message });
        }
      }, CONFIG.SCAN_INTERVAL_MS);
    }

    registerShutdownHandlers(scanner, monitor);
  } catch (error) {
    logger.error('[index] Startup failed:', { error: error.message });
    process.exitCode = 1;
  }
}

function loadWallet() {
  try {
    const privateKey = process.env.PRIVATE_KEY;

    if (!privateKey || privateKey === 'your_base58_private_key_here') {
      if (CONFIG.SIMULATION_MODE) {
        usingTemporarySimulationWallet = true;
        logger.info('[startup] PRIVATE_KEY missing; generated temporary simulation wallet.');
        return Keypair.generate();
      }
      logger.error('[startup] PRIVATE_KEY is required when SIMULATION_MODE=false.');
      process.exit(1);
    }

    const secretKey = bs58.decode(privateKey);
    usingTemporarySimulationWallet = false;
    return Keypair.fromSecretKey(secretKey);
  } catch (error) {
    logger.error('[startup] Failed to load wallet from PRIVATE_KEY:', { error: error.message });
    process.exit(1);
  }
}

async function getStartupBalance(wallet) {
  try {
    if (CONFIG.SIMULATION_MODE) return Math.floor(CONFIG.SIMULATION_BALANCE_SOL * 1e9);
    const balance = await callRpc('getBalance', [
      wallet.publicKey.toBase58(),
      { commitment: 'confirmed' }
    ]);
    return Number(balance?.value || 0);
  } catch (error) {
    logger.error('[startup] Failed to fetch wallet SOL balance:', { error: error.message });
    return 0;
  }
}

async function processDiscoveryCandidate(candidate, monitor, executor) {
  try {
    if (isDiscoveryProcessing || shuttingDown || botState.paused) return;
    isDiscoveryProcessing = true;
    await processCandidate(candidate, monitor, executor, {
      skipMarketFilter: true,
      source: 'helius'
    });
  } catch (error) {
    logger.error(`[index] Discovery candidate processing failed for ${candidate?.symbol || 'unknown'}:`, { error: error.message });
  } finally {
    isDiscoveryProcessing = false;
  }
}

async function scanAndTrade(scanner, monitor, executor) {
  try {
    const candidates = await scanner.scan();
    if (!candidates.length) return;

    const aiDecisionTracker = { count: 0 };

    for (const candidate of candidates) {
      try {
        if (botState.paused || shuttingDown) {
          logger.info('[scan] Scan paused; stopping candidate processing.');
          break;
        }

        await processCandidate(candidate, monitor, executor, {
          aiDecisionTracker,
          skipMarketFilter: false,
          source: 'dexscreener'
        });
      } catch (error) {
        logger.error(`[index] Candidate processing failed for ${candidate?.symbol || 'unknown'}:`, { error: error.message });
      }
    }
  } catch (error) {
    logger.error('[index] scanAndTrade failed:', { error: error.message });
  }
}

async function processCandidate(candidate, monitor, executor, options = {}) {
  const aiDecisionTracker = options.aiDecisionTracker || null;

  if (!candidate?.tokenAddress) {
    recordScanActivity('FILTER_SKIP', candidate, 'missing token address');
    return;
  }

  if (isDailyLimitBreached()) {
    logger.info(`[scan] Skip ${candidate.symbol}: daily loss limit breached.`);
    recordScanActivity('DAILY_LIMIT_SKIP', candidate, 'daily loss limit breached');
    return;
  }

  if (!options.skipMarketFilter) {
    const filterResult = filterCandidate(candidate, monitor.positions);
    if (!filterResult.passed) {
      logger.info(`[scan] Skip ${candidate.symbol}: ${filterResult.reason}`);
      recordScanActivity('FILTER_SKIP', candidate, filterResult.reason);
      return;
    }
  }

  const cachedDecision = getCachedAiDecision(candidate.tokenAddress);
  if (cachedDecision?.tradedAt) {
    logger.info(`[scan] Skip ${candidate.symbol}: already traded from cached AI decision.`);
    recordScanActivity('TRADED_CACHE_SKIP', candidate, 'already traded from cached AI decision');
    return;
  }

  const safe = await isTokenSafe(candidate.tokenAddress);
  if (!safe) {
    logger.info(`[scan] Skip ${candidate.symbol}: RugCheck rejected token.`);
    recordScanActivity('RUGCHECK_SKIP', candidate, 'RugCheck rejected token');
    return;
  }

  if (!cachedDecision && aiDecisionTracker && aiDecisionTracker.count >= CONFIG.AI_MAX_NEW_DECISIONS_PER_SCAN) {
    logger.info(`[scan] Skip ${candidate.symbol}: AI already analyzed a new token this scan.`);
    recordScanActivity('AI_SCAN_LIMIT_SKIP', candidate, 'AI already analyzed a new token this scan');
    return;
  }

  const scoreResult = cachedDecision?.scoreResult || await scoreAndCacheCandidate(candidate);
  if (!cachedDecision && aiDecisionTracker) {
    aiDecisionTracker.count += 1;
  }

  if (scoreResult.score < CONFIG.GEMINI_SCORE_THRESHOLD) {
    const cacheNote = cachedDecision ? 'cached ' : '';
    logger.info(`[scan] Skip ${candidate.symbol}: ${cacheNote}Gemini score ${scoreResult.score}/10 (${scoreResult.reason})`);
    recordScanActivity('AI_SKIP', candidate, `${cacheNote}Gemini score ${scoreResult.score}/10: ${scoreResult.reason}`, scoreResult.score);
    return;
  }

  if (!canOpenPosition() || monitor.positions.size >= CONFIG.MAX_CONCURRENT_POSITIONS) {
    logger.info(`[scan] Skip ${candidate.symbol}: max open positions reached.`);
    recordScanActivity('POSITION_LIMIT_SKIP', candidate, 'max open positions reached', scoreResult.score);
    return;
  }

  if (botState.paused || shuttingDown) {
    logger.info(`[scan] Skip ${candidate.symbol}: bot paused before buy.`);
    return;
  }

  logger.info(`[scan] Opportunity ${candidate.symbol} score=${scoreResult.score}/10 reason="${scoreResult.reason}"`);
  recordScanActivity('OPPORTUNITY', candidate, scoreResult.reason, scoreResult.score);
  const buyResult = await executor.buy(candidate);
  if (buyResult.success) {
    markAiDecisionTraded(candidate.tokenAddress);
    insertTrade({
      mint: candidate.tokenAddress,
      side: 'buy',
      amount_sol: CONFIG.TRADE_SIZE_SOL,
      price_usd: Number(candidate.priceUsd || 0),
      tx_signature: buyResult.txSignature,
      timestamp: Date.now()
    });
    openStatePosition(candidate.tokenAddress);
    monitor.addPosition(candidate, buyResult);
    recordScanActivity('BUY_SUCCESS', candidate, `tx=${buyResult.txSignature}`, scoreResult.score);
  } else {
    logger.error(`[scan] Buy failed for ${candidate.symbol}.`);
    recordScanActivity('BUY_FAIL', candidate, 'executor buy failed', scoreResult.score);
  }
}

async function scoreAndCacheCandidate(candidate) {
  try {
    const scoreResult = await scoreCandidate(candidate);
    if (scoreResult.cacheable !== false) {
      aiDecisionCache.set(candidate.tokenAddress, {
        scoreResult,
        symbol: candidate.symbol,
        firstSeenAt: Date.now(),
        expiresAt: Date.now() + CONFIG.AI_DECISION_CACHE_MS,
        tradedAt: 0
      });
    } else {
      logger.info(`[scan] Did not cache Gemini result for ${candidate?.symbol || candidate?.tokenAddress || 'unknown'}: ${scoreResult.reason}`);
    }
    return scoreResult;
  } catch (error) {
    logger.error(`[index] Failed to score/cache ${candidate?.symbol || candidate?.tokenAddress || 'unknown'}:`, { error: error.message });
    return { score: 0, reason: `score cache failed: ${error.message}`, cacheable: false };
  }
}

function getCachedAiDecision(tokenAddress) {
  try {
    const cached = aiDecisionCache.get(tokenAddress);
    if (!cached) return null;

    const expiry = cached.tradedAt
      ? cached.tradedAt + CONFIG.TRADED_TOKEN_COOLDOWN_MS
      : cached.expiresAt;

    if (Date.now() > expiry) {
      aiDecisionCache.delete(tokenAddress);
      return null;
    }

    return cached;
  } catch (error) {
    logger.error(`[index] Failed to read AI decision cache for ${tokenAddress}:`, { error: error.message });
    return null;
  }
}

function markAiDecisionTraded(tokenAddress) {
  try {
    const cached = aiDecisionCache.get(tokenAddress);
    if (cached) {
      cached.tradedAt = Date.now();
      cached.expiresAt = Date.now() + CONFIG.TRADED_TOKEN_COOLDOWN_MS;
      aiDecisionCache.set(tokenAddress, cached);
    }
  } catch (error) {
    logger.error(`[index] Failed to mark AI decision traded for ${tokenAddress}:`, { error: error.message });
  }
}

function startRemoteBridge(monitor, wallet) {
  try {
    const bridge = new RemoteBridge({
      getStatus: () => buildStatusPayload(monitor, wallet),
      onCommand: async (command) => {
        applyControlAction(command.action, 'remote');
      }
    });
    bridge.start();
    return bridge;
  } catch (error) {
    logger.error('[remote] Failed to initialize remote bridge:', { error: error.message });
    return null;
  }
}

function startDashboardServer(monitor, wallet) {
  try {
    const app = express();
    const dashboardDir = path.join(rootDir, 'dashboard');

    app.get('/api/status', async (req, res) => {
      try {
        res.json(await buildStatusPayload(monitor, wallet));
      } catch (error) {
        logger.error('[dashboard] Failed to serve /api/status:', { error: error.message });
        res.status(500).json({ error: 'status unavailable' });
      }
    });

    app.get('/api/trades', (req, res) => {
      try {
        const mint = String(req.query.mint || '').trim();
        const date = String(req.query.date || '').trim();

        if (mint) {
          res.json(getTradesByMint(mint));
          return;
        }

        if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          res.json({ pnlSol: getDailyPnl(date) });
          return;
        }

        res.status(400).json({ error: 'Provide ?mint=<address> or ?date=<YYYY-MM-DD>.' });
      } catch (error) {
        logger.error('[dashboard] Failed to serve /api/trades:', { error: error.message });
        res.status(500).json({ error: 'trades unavailable' });
      }
    });

    app.post('/api/control/start', (req, res) => {
      try {
        const bot = applyControlAction('start', 'local-dashboard');
        res.json({ success: true, bot });
      } catch (error) {
        logger.error('[dashboard] Failed to start bot:', { error: error.message });
        res.status(500).json({ success: false, error: 'start failed' });
      }
    });

    app.post('/api/control/stop', (req, res) => {
      try {
        const bot = applyControlAction('stop', 'local-dashboard');
        res.json({ success: true, bot });
      } catch (error) {
        logger.error('[dashboard] Failed to stop bot:', { error: error.message });
        res.status(500).json({ success: false, error: 'stop failed' });
      }
    });

    app.use(express.static(dashboardDir));

    const startedServer = app.listen(CONFIG.DASHBOARD_PORT, () => {
      try {
        logger.info(`[dashboard] http://localhost:${CONFIG.DASHBOARD_PORT}`);
      } catch (error) {
        logger.error('[dashboard] Failed to log dashboard URL:', { error: error.message });
      }
    });

    return startedServer;
  } catch (error) {
    logger.error('[dashboard] Failed to start dashboard server:', { error: error.message });
    return null;
  }
}

async function buildStatusPayload(monitor, wallet) {
  const status = await monitor.getStatus();
  status.bot = getBotStatus();
  status.tradingState = getStateSnapshot();
  status.geminiBudget = await getGeminiBudgetStatus();
  status.scanActivityLog = scanActivityLog.slice(0, SCAN_ACTIVITY_LOG_LIMIT);
  status.wallet = getWalletStatus(wallet);
  return status;
}

function getWalletStatus(wallet) {
  try {
    const publicKey = wallet?.publicKey?.toBase58?.() || '';
    return {
      publicKey,
      topUpAddress: usingTemporarySimulationWallet ? '' : publicKey,
      temporary: Boolean(usingTemporarySimulationWallet),
      explorerUrl: publicKey ? `https://solscan.io/account/${publicKey}` : ''
    };
  } catch (error) {
    logger.error('[dashboard] Failed to build wallet status:', { error: error.message });
    return {
      publicKey: '',
      topUpAddress: '',
      temporary: false,
      explorerUrl: ''
    };
  }
}

function applyControlAction(action, source = 'local') {
  const normalized = String(action || '').toLowerCase();
  if (!['start', 'stop'].includes(normalized)) {
    throw new Error(`Unknown control action: ${action}`);
  }

  botState.paused = normalized === 'stop';
  botState.lastControlAction = normalized === 'start' ? 'started' : 'stopped';
  botState.lastControlSource = source;
  botState.updatedAt = Date.now();

  if (normalized === 'start') {
    logger.info(`[control] Bot started from ${source}.`);
  } else {
    logger.info(`[control] Bot stopped from ${source}. New scans and buys are paused.`);
  }

  return getBotStatus();
}

function getBotStatus() {
  try {
    return {
      running: !botState.paused && !shuttingDown,
      paused: Boolean(botState.paused),
      isScanning: Boolean(isScanning),
      isDiscoveryProcessing: Boolean(isDiscoveryProcessing),
      shuttingDown: Boolean(shuttingDown),
      heliusEnabled: Boolean(CONFIG.HELIUS_API_KEY),
      lastControlAction: String(botState.lastControlAction),
      lastControlSource: String(botState.lastControlSource || 'unknown'),
      updatedAt: Number(botState.updatedAt)
    };
  } catch (error) {
    logger.error('[dashboard] Failed to build bot status:', { error: error.message });
    return {
      running: false,
      paused: true,
      isScanning: false,
      isDiscoveryProcessing: false,
      shuttingDown: Boolean(shuttingDown),
      heliusEnabled: Boolean(CONFIG.HELIUS_API_KEY),
      lastControlAction: 'unknown',
      lastControlSource: 'unknown',
      updatedAt: Date.now()
    };
  }
}

function recordScanActivity(action, candidate, reason, score = null) {
  try {
    scanActivityLog.unshift({
      timestamp: Date.now(),
      action: String(action),
      tokenAddress: String(candidate?.tokenAddress || ''),
      symbol: String(candidate?.symbol || 'UNKNOWN'),
      priceUsd: Number(candidate?.priceUsd || 0),
      liquidityUsd: Number(candidate?.liquidity?.usd || 0),
      volumeH1: Number(candidate?.volumeH1 || 0),
      priceChange5m: Number(candidate?.priceChange5m || 0),
      score: score === null || score === undefined ? null : Number(score),
      reason: String(reason || '')
    });
    if (scanActivityLog.length > SCAN_ACTIVITY_LOG_LIMIT) {
      scanActivityLog.length = SCAN_ACTIVITY_LOG_LIMIT;
    }
  } catch (error) {
    logger.error('[scan] Failed to record scan activity:', { error: error.message });
  }
}

function registerShutdownHandlers(scanner, monitor) {
  try {
    const shutdown = async (signal) => {
      try {
        if (shuttingDown) return;
        shuttingDown = true;
        logger.info(`[shutdown] ${signal} received; writing state and closing positions before exit.`);
        if (scanInterval) clearInterval(scanInterval);
        if (remoteBridge) remoteBridge.stop();
        await writeShutdownState(signal, monitor);
        if (discovery) discovery.close();
        scanner.close();
        monitor.stop();
        await monitor.closeAllPositions('shutdown');
        await closeDashboardServer();
        process.exit(0);
      } catch (error) {
        logger.error('[shutdown] Graceful shutdown failed:', { error: error.message });
        process.exit(1);
      }
    };

    process.on('SIGINT', () => {
      try {
        shutdown('SIGINT').catch((error) => {
          logger.error('[shutdown] SIGINT handler promise failed:', { error: error.message });
        });
      } catch (error) {
        logger.error('[shutdown] SIGINT handler failed:', { error: error.message });
      }
    });

    process.on('SIGTERM', () => {
      try {
        shutdown('SIGTERM').catch((error) => {
          logger.error('[shutdown] SIGTERM handler promise failed:', { error: error.message });
        });
      } catch (error) {
        logger.error('[shutdown] SIGTERM handler failed:', { error: error.message });
      }
    });
  } catch (error) {
    logger.error('[shutdown] Failed to register shutdown handlers:', { error: error.message });
  }
}

async function writeShutdownState(signal, monitor) {
  const openPositions = monitor.getOpenPositionsSnapshot();
  const payload = {
    signal,
    timestamp: new Date().toISOString(),
    openPositions,
    tradingState: getStateSnapshot(),
    pnl: {
      realizedPnlSol: Number(monitor.totalPnlSol || 0),
      unrealizedPnlSol: Number(openPositions.reduce((total, position) => total + Number(position.pnlSol || 0), 0)),
      totalPnlSol: Number(monitor.totalPnlSol || 0)
        + Number(openPositions.reduce((total, position) => total + Number(position.pnlSol || 0), 0))
    }
  };

  await fs.writeFile(
    path.join(rootDir, 'shutdown_state.json'),
    JSON.stringify(payload, null, 2)
  );
}

async function closeDashboardServer() {
  if (!server) return;

  await new Promise((resolve) => {
    server.close((error) => {
      if (error) logger.error('[shutdown] Dashboard server close failed:', { error: error.message });
      resolve();
    });
  });
}

main().catch((error) => {
  try {
    logger.error('[index] Main promise failed:', { error: error.message });
    process.exitCode = 1;
  } catch (handlerError) {
    logger.error('[index] Failed to log main promise error:', { error: handlerError.message });
    process.exitCode = 1;
  }
});
