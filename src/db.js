import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import CONFIG from '../config.js';
import logger from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'data');
const dbPath = path.join(dataDir, CONFIG.SIMULATION_MODE ? 'trades_sim.db' : 'trades.db');

fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mint TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
    amount_sol REAL NOT NULL,
    price_usd REAL NOT NULL,
    tx_signature TEXT NOT NULL,
    timestamp INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_trades_mint ON trades (mint);
  CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades (timestamp);
`);

const insertTradeStatement = db.prepare(`
  INSERT INTO trades (mint, side, amount_sol, price_usd, tx_signature, timestamp)
  VALUES (@mint, @side, @amount_sol, @price_usd, @tx_signature, @timestamp)
`);

const getTradesByMintStatement = db.prepare(`
  SELECT id, mint, side, amount_sol, price_usd, tx_signature, timestamp
  FROM trades
  WHERE mint = ?
  ORDER BY timestamp DESC
`);

const getDailyPnlStatement = db.prepare(`
  SELECT COALESCE(SUM(
    CASE side
      WHEN 'sell' THEN amount_sol
      ELSE -amount_sol
    END
  ), 0) AS pnl_sol
  FROM trades
  WHERE timestamp >= ? AND timestamp < ?
`);

export function insertTrade(trade) {
  try {
    const normalized = normalizeTrade(trade);
    if (!normalized) return null;
    const result = insertTradeStatement.run(normalized);
    return Number(result.lastInsertRowid);
  } catch (error) {
    logger.error('[db] Failed to insert trade:', { error: error.message });
    return null;
  }
}

export function getTradesByMint(mint) {
  try {
    return getTradesByMintStatement.all(String(mint || ''));
  } catch (error) {
    logger.error('[db] Failed to get trades by mint:', { error: error.message });
    return [];
  }
}

export function getDailyPnl(dateUtcString) {
  try {
    const start = Date.parse(`${dateUtcString}T00:00:00.000Z`);
    if (!Number.isFinite(start)) return 0;
    const end = start + 24 * 60 * 60 * 1000;
    const row = getDailyPnlStatement.get(start, end);
    return Number(row?.pnl_sol || 0);
  } catch (error) {
    logger.error('[db] Failed to get daily PnL:', { error: error.message });
    return 0;
  }
}

function normalizeTrade(trade) {
  const side = String(trade?.side || '').toLowerCase();
  if (!['buy', 'sell'].includes(side)) {
    logger.error('[db] Invalid trade side; expected buy or sell.', { side });
    return null;
  }

  return {
    mint: String(trade?.mint || trade?.tokenAddress || ''),
    side,
    amount_sol: Number(trade?.amount_sol ?? trade?.amountSol ?? 0),
    price_usd: Number(trade?.price_usd ?? trade?.priceUsd ?? 0),
    tx_signature: String(trade?.tx_signature || trade?.txSignature || ''),
    timestamp: Number(trade?.timestamp || Date.now())
  };
}
