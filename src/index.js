import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import bs58 from 'bs58';
import { Connection, Keypair } from '@solana/web3.js';
import CONFIG from '../config.js';
import Scanner from './scanner.js';
import { filterCandidate } from './filter.js';
import { getGeminiBudgetStatus, scoreCandidate } from './scorer.js';
import Executor from './executor.js';
import Monitor from './monitor.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

let isScanning = false;
let shuttingDown = false;
let scanInterval = null;
let server = null;
const aiDecisionCache = new Map();
const scanActivityLog = [];
const SCAN_ACTIVITY_LOG_LIMIT = 100;
const botState = {
  paused: false,
  lastControlAction: 'started',
  updatedAt: Date.now()
};

async function main() {
  try {
    process.on('unhandledRejection', (reason) => {
      try {
        console.error('[index] Unhandled promise rejection caught:', reason);
      } catch (error) {
        console.error('[index] Failed to log unhandled rejection:', error.message);
      }
    });

    process.on('uncaughtException', (error) => {
      try {
        console.error('[index] Uncaught exception caught:', error.message);
      } catch (handlerError) {
        console.error('[index] Failed to log uncaught exception:', handlerError.message);
      }
    });

    const connection = new Connection(CONFIG.RPC_URL, 'confirmed');
    const wallet = loadWallet();
    const balanceLamports = await getStartupBalance(connection, wallet);

    console.log(`[startup] Wallet: ${wallet.publicKey.toBase58()}`);
    console.log(`[startup] SOL balance: ${(balanceLamports / 1e9).toFixed(6)} SOL`);
    console.log(`[startup] Simulation mode: ${CONFIG.SIMULATION_MODE ? 'ON' : 'OFF'}`);

    const scanner = new Scanner();
    scanner.startOptionalWebSocketFeed();

    const executor = new Executor(connection, wallet);
    const monitor = new Monitor(executor, connection);
    monitor.start();

    server = startDashboardServer(monitor);

    const runScan = async () => {
      try {
        if (isScanning || shuttingDown || botState.paused) return;
        isScanning = true;
        await scanAndTrade(scanner, monitor, executor);
      } catch (error) {
        console.error('[index] Scan loop failed:', error.message);
      } finally {
        isScanning = false;
      }
    };

    await runScan();
    scanInterval = setInterval(() => {
      try {
        runScan().catch((error) => {
          console.error('[index] Scheduled scan promise failed:', error.message);
        });
      } catch (error) {
        console.error('[index] Scheduled scan failed:', error.message);
      }
    }, CONFIG.SCAN_INTERVAL_MS);

    registerShutdownHandlers(scanner, monitor);
  } catch (error) {
    console.error('[index] Startup failed:', error.message);
    process.exitCode = 1;
  }
}

function loadWallet() {
  try {
    const privateKey = process.env.PRIVATE_KEY;

    if (!privateKey || privateKey === 'your_base58_private_key_here') {
      if (CONFIG.SIMULATION_MODE) {
        console.log('[startup] PRIVATE_KEY missing; generated temporary simulation wallet.');
        return Keypair.generate();
      }
      console.error('[startup] PRIVATE_KEY is required when SIMULATION_MODE=false.');
      process.exit(1);
    }

    const secretKey = bs58.decode(privateKey);
    return Keypair.fromSecretKey(secretKey);
  } catch (error) {
    console.error('[startup] Failed to load wallet from PRIVATE_KEY:', error.message);
    process.exit(1);
  }
}

async function getStartupBalance(connection, wallet) {
  try {
    return await connection.getBalance(wallet.publicKey, 'confirmed');
  } catch (error) {
    console.error('[startup] Failed to fetch wallet SOL balance:', error.message);
    return 0;
  }
}

async function scanAndTrade(scanner, monitor, executor) {
  try {
    const candidates = await scanner.scan();
    if (!candidates.length) return;

    let newAiDecisionsThisScan = 0;

    for (const candidate of candidates) {
      try {
        if (botState.paused || shuttingDown) {
          console.log('[scan] Scan paused; stopping candidate processing.');
          break;
        }

        const filterResult = filterCandidate(candidate, monitor.positions);
        if (!filterResult.passed) {
          console.log(`[scan] Skip ${candidate.symbol}: ${filterResult.reason}`);
          recordScanActivity('FILTER_SKIP', candidate, filterResult.reason);
          continue;
        }

        const cachedDecision = getCachedAiDecision(candidate.tokenAddress);
        if (cachedDecision?.tradedAt) {
          console.log(`[scan] Skip ${candidate.symbol}: already traded from cached AI decision.`);
          recordScanActivity('TRADED_CACHE_SKIP', candidate, 'already traded from cached AI decision');
          continue;
        }

        if (!cachedDecision && newAiDecisionsThisScan >= CONFIG.AI_MAX_NEW_DECISIONS_PER_SCAN) {
          console.log(`[scan] Skip ${candidate.symbol}: AI already analyzed a new token this scan.`);
          recordScanActivity('AI_SCAN_LIMIT_SKIP', candidate, 'AI already analyzed a new token this scan');
          continue;
        }

        const scoreResult = cachedDecision?.scoreResult || await scoreAndCacheCandidate(candidate);
        if (!cachedDecision) {
          newAiDecisionsThisScan += 1;
        }
        if (scoreResult.score < CONFIG.GEMINI_SCORE_THRESHOLD) {
          const cacheNote = cachedDecision ? 'cached ' : '';
          console.log(`[scan] Skip ${candidate.symbol}: ${cacheNote}Gemini score ${scoreResult.score}/10 (${scoreResult.reason})`);
          recordScanActivity('AI_SKIP', candidate, `${cacheNote}Gemini score ${scoreResult.score}/10: ${scoreResult.reason}`, scoreResult.score);
          continue;
        }

        if (monitor.positions.size >= CONFIG.MAX_CONCURRENT_POSITIONS) {
          console.log(`[scan] Skip ${candidate.symbol}: max concurrent positions reached.`);
          recordScanActivity('POSITION_LIMIT_SKIP', candidate, 'max concurrent positions reached', scoreResult.score);
          continue;
        }

        if (botState.paused || shuttingDown) {
          console.log(`[scan] Skip ${candidate.symbol}: bot paused before buy.`);
          break;
        }

        console.log(`[scan] Opportunity ${candidate.symbol} score=${scoreResult.score}/10 reason="${scoreResult.reason}"`);
        recordScanActivity('OPPORTUNITY', candidate, scoreResult.reason, scoreResult.score);
        const buyResult = await executor.buy(candidate);
        if (buyResult.success) {
          markAiDecisionTraded(candidate.tokenAddress);
          monitor.addPosition(candidate, buyResult);
          recordScanActivity('BUY_SUCCESS', candidate, `tx=${buyResult.txSignature}`, scoreResult.score);
        } else {
          console.error(`[scan] Buy failed for ${candidate.symbol}.`);
          recordScanActivity('BUY_FAIL', candidate, 'executor buy failed', scoreResult.score);
        }
      } catch (error) {
        console.error(`[index] Candidate processing failed for ${candidate?.symbol || 'unknown'}:`, error.message);
      }
    }
  } catch (error) {
    console.error('[index] scanAndTrade failed:', error.message);
  }
}

async function scoreAndCacheCandidate(candidate) {
  try {
    const scoreResult = await scoreCandidate(candidate);
    aiDecisionCache.set(candidate.tokenAddress, {
      scoreResult,
      symbol: candidate.symbol,
      firstSeenAt: Date.now(),
      expiresAt: Date.now() + CONFIG.AI_DECISION_CACHE_MS,
      tradedAt: 0
    });
    return scoreResult;
  } catch (error) {
    console.error(`[index] Failed to score/cache ${candidate?.symbol || candidate?.tokenAddress || 'unknown'}:`, error.message);
    return { score: 0, reason: `score cache failed: ${error.message}` };
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
    console.error(`[index] Failed to read AI decision cache for ${tokenAddress}:`, error.message);
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
    console.error(`[index] Failed to mark AI decision traded for ${tokenAddress}:`, error.message);
  }
}

function startDashboardServer(monitor) {
  try {
    const app = express();
    const dashboardDir = path.join(rootDir, 'dashboard');

    app.get('/api/status', async (req, res) => {
      try {
        const status = await monitor.getStatus();
        status.bot = getBotStatus();
        status.geminiBudget = await getGeminiBudgetStatus();
        status.scanActivityLog = scanActivityLog.slice(0, SCAN_ACTIVITY_LOG_LIMIT);
        res.json(status);
      } catch (error) {
        console.error('[dashboard] Failed to serve /api/status:', error.message);
        res.status(500).json({ error: 'status unavailable' });
      }
    });

    app.post('/api/control/start', (req, res) => {
      try {
        botState.paused = false;
        botState.lastControlAction = 'started';
        botState.updatedAt = Date.now();
        console.log('[control] Bot started from dashboard.');
        res.json({ success: true, bot: getBotStatus() });
      } catch (error) {
        console.error('[dashboard] Failed to start bot:', error.message);
        res.status(500).json({ success: false, error: 'start failed' });
      }
    });

    app.post('/api/control/stop', (req, res) => {
      try {
        botState.paused = true;
        botState.lastControlAction = 'stopped';
        botState.updatedAt = Date.now();
        console.log('[control] Bot stopped from dashboard. New scans and buys are paused.');
        res.json({ success: true, bot: getBotStatus() });
      } catch (error) {
        console.error('[dashboard] Failed to stop bot:', error.message);
        res.status(500).json({ success: false, error: 'stop failed' });
      }
    });

    app.use(express.static(dashboardDir));

    const startedServer = app.listen(CONFIG.DASHBOARD_PORT, () => {
      try {
        console.log(`[dashboard] http://localhost:${CONFIG.DASHBOARD_PORT}`);
      } catch (error) {
        console.error('[dashboard] Failed to log dashboard URL:', error.message);
      }
    });

    return startedServer;
  } catch (error) {
    console.error('[dashboard] Failed to start dashboard server:', error.message);
    return null;
  }
}

function getBotStatus() {
  try {
    return {
      running: !botState.paused && !shuttingDown,
      paused: Boolean(botState.paused),
      isScanning: Boolean(isScanning),
      shuttingDown: Boolean(shuttingDown),
      lastControlAction: String(botState.lastControlAction),
      updatedAt: Number(botState.updatedAt)
    };
  } catch (error) {
    console.error('[dashboard] Failed to build bot status:', error.message);
    return {
      running: false,
      paused: true,
      isScanning: false,
      shuttingDown: Boolean(shuttingDown),
      lastControlAction: 'unknown',
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
    console.error('[scan] Failed to record scan activity:', error.message);
  }
}

function registerShutdownHandlers(scanner, monitor) {
  try {
    const shutdown = async (signal) => {
      try {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`[shutdown] ${signal} received; closing positions before exit.`);
        if (scanInterval) clearInterval(scanInterval);
        scanner.close();
        monitor.stop();
        await monitor.closeAllPositions('shutdown');
        if (server) {
          server.close((error) => {
            try {
              if (error) console.error('[shutdown] Dashboard server close failed:', error.message);
              process.exit(0);
            } catch (handlerError) {
              console.error('[shutdown] Server close handler failed:', handlerError.message);
              process.exit(0);
            }
          });
        } else {
          process.exit(0);
        }
      } catch (error) {
        console.error('[shutdown] Graceful shutdown failed:', error.message);
        process.exit(1);
      }
    };

    process.on('SIGINT', () => {
      try {
        shutdown('SIGINT').catch((error) => {
          console.error('[shutdown] SIGINT handler promise failed:', error.message);
        });
      } catch (error) {
        console.error('[shutdown] SIGINT handler failed:', error.message);
      }
    });

    process.on('SIGTERM', () => {
      try {
        shutdown('SIGTERM').catch((error) => {
          console.error('[shutdown] SIGTERM handler promise failed:', error.message);
        });
      } catch (error) {
        console.error('[shutdown] SIGTERM handler failed:', error.message);
      }
    });
  } catch (error) {
    console.error('[shutdown] Failed to register shutdown handlers:', error.message);
  }
}

main().catch((error) => {
  try {
    console.error('[index] Main promise failed:', error.message);
    process.exitCode = 1;
  } catch (handlerError) {
    console.error('[index] Failed to log main promise error:', handlerError.message);
    process.exitCode = 1;
  }
});
