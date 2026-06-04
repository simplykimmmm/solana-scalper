import { rejectMethod, requireAuth, sendJson } from './_http.js';
import { getCommand, getStatusSnapshot, isPersistentStoreConfigured } from './_store.js';

const STALE_MS = Number(process.env.REMOTE_BRIDGE_STALE_MS || 15000);

export default async function handler(req, res) {
  if (rejectMethod(req, res, ['GET'])) return;
  if (!requireAuth(req, res)) return;

  try {
    const snapshot = await getStatusSnapshot();
    const command = await getCommand();
    const now = Date.now();
    const ageMs = snapshot?.receivedAt ? now - Number(snapshot.receivedAt) : null;
    const status = snapshot?.status || emptyStatus();

    sendJson(res, 200, {
      ...status,
      remote: {
        online: typeof ageMs === 'number' && ageMs <= STALE_MS,
        stale: typeof ageMs !== 'number' || ageMs > STALE_MS,
        ageMs,
        lastSeenAt: snapshot?.receivedAt || null,
        agentId: snapshot?.agentId || '',
        persistentStore: isPersistentStoreConfigured(),
        lastCommand: command || null
      }
    });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

function emptyStatus() {
  return {
    simulationMode: true,
    solBalance: 0,
    solPriceUsd: 0,
    totalTrades: 0,
    winRate: 0,
    totalPnlSol: 0,
    totalPnlUsd: 0,
    realizedPnlSol: 0,
    realizedPnlUsd: 0,
    unrealizedPnlSol: 0,
    unrealizedPnlUsd: 0,
    openPositions: [],
    openPositionLog: [],
    closedTrades: [],
    scanActivityLog: [],
    wallet: {
      publicKey: '',
      topUpAddress: '',
      temporary: false,
      explorerUrl: ''
    },
    bot: {
      running: false,
      paused: true,
      isScanning: false,
      isDiscoveryProcessing: false,
      shuttingDown: false,
      heliusEnabled: false,
      lastControlAction: 'unknown',
      lastControlSource: 'none',
      updatedAt: Date.now()
    },
    tradingState: {
      openPositions: [],
      dailyPnlSol: 0,
      maxOpenPositions: 0,
      maxDailyLossSol: 0,
      dailyLimitBreached: false
    },
    geminiBudget: {
      enabled: false,
      tokensRemainingToday: 0,
      usableTokens: 0,
      requestsThisRun: 0,
      maxRequestsPerRun: 0
    }
  };
}
