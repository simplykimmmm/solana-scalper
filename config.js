import dotenv from 'dotenv';
import logger from './src/logger.js';

dotenv.config();

function envBoolean(name, defaultValue) {
  try {
    const value = process.env[name];
    if (value === undefined) return defaultValue;
    return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
  } catch (error) {
    logger.error(`[config] Failed to read boolean env ${name}:`, { error: error.message });
    return defaultValue;
  }
}

function envNumber(name, defaultValue) {
  try {
    const value = Number(process.env[name]);
    if (!Number.isFinite(value)) return defaultValue;
    return value;
  } catch (error) {
    logger.error(`[config] Failed to read number env ${name}:`, { error: error.message });
    return defaultValue;
  }
}

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';

const CONFIG = {
  MIN_LIQUIDITY_USD: 5000,
  VOLUME_SPIKE_MULTIPLIER: 1.5,
  GEMINI_SCORE_THRESHOLD: 5,
  GEMINI_BUDGET_MODE: envBoolean('GEMINI_BUDGET_MODE', true),
  GEMINI_MAX_REQUESTS_PER_RUN: envNumber('GEMINI_MAX_REQUESTS_PER_RUN', 10),
  GEMINI_MIN_REQUEST_INTERVAL_MS: envNumber('GEMINI_MIN_REQUEST_INTERVAL_MS', 0),
  GEMINI_DAILY_TOKEN_LIMIT: envNumber('GEMINI_DAILY_TOKEN_LIMIT', 1500),
  GEMINI_DAILY_TOKEN_RESERVE: envNumber('GEMINI_DAILY_TOKEN_RESERVE', 50),
  GEMINI_MAX_OUTPUT_TOKENS: envNumber('GEMINI_MAX_OUTPUT_TOKENS', 120),
  GEMINI_MODEL,
  GEMINI_BUDGET_TIME_ZONE: process.env.GEMINI_BUDGET_TIME_ZONE || 'Europe/Luxembourg',
  AI_DECISION_CACHE_MS: envNumber('AI_DECISION_CACHE_MS', 21600000),
  TRADED_TOKEN_COOLDOWN_MS: envNumber('TRADED_TOKEN_COOLDOWN_MS', 21600000),
  AI_MAX_NEW_DECISIONS_PER_SCAN: envNumber('AI_MAX_NEW_DECISIONS_PER_SCAN', 1),
  SLIPPAGE_BPS: 150,
  SLIPPAGE_BPS_LOW_LIQ: 300,
  SLIPPAGE_LIQUIDITY_THRESHOLD: envNumber('SLIPPAGE_LIQUIDITY_THRESHOLD', 50000),
  PRIORITY_FEE: envNumber('PRIORITY_FEE', envNumber('PRIORITY_FEE_LAMPORTS', 100000)),
  PRIORITY_FEE_LAMPORTS: envNumber('PRIORITY_FEE_LAMPORTS', envNumber('PRIORITY_FEE', 100000)),
  TRADE_SIZE_SOL: 0.05,
  TAKE_PROFIT_PERCENT: 5,
  STOP_LOSS_PERCENT: 3,
  MAX_HOLD_SECONDS: 30,
  MOMENTUM_EXTENDED_HOLD_SECONDS: 1800,
  MOMENTUM_MIN_PRICE_CHANGE_5M: 8,
  MOMENTUM_MIN_VOLUME_SPIKE: 2,
  MOMENTUM_TAKE_PROFIT_PERCENT: 18,
  MOMENTUM_TRAILING_STOP_PERCENT: 4,
  MOMENTUM_MIN_PROFIT_FOR_TRAILING_PERCENT: 4,
  MAX_OPEN_POSITIONS: envNumber('MAX_OPEN_POSITIONS', 3),
  MAX_CONCURRENT_POSITIONS: envNumber('MAX_CONCURRENT_POSITIONS', envNumber('MAX_OPEN_POSITIONS', 3)),
  MAX_DAILY_LOSS_SOL: envNumber('MAX_DAILY_LOSS_SOL', 0.5),
  SCAN_INTERVAL_MS: 2000,
  SIMULATION_MODE: envBoolean('SIMULATION_MODE', true),
  SIMULATION_BALANCE_SOL: envNumber('SIMULATION_BALANCE_SOL', 0.2),
  PRIMARY_RPC_URL: process.env.PRIMARY_RPC_URL || process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
  FALLBACK_RPC_URL: process.env.FALLBACK_RPC_URL || 'https://api.mainnet-beta.solana.com',
  RPC_URL: process.env.RPC_URL || process.env.PRIMARY_RPC_URL || 'https://api.mainnet-beta.solana.com',
  HELIUS_API_KEY: process.env.HELIUS_API_KEY || '',
  JITO_ENABLED: envBoolean('JITO_ENABLED', false),
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  RPC_MAX_ATTEMPTS: envNumber('RPC_MAX_ATTEMPTS', 4),
  RPC_BASE_DELAY_MS: envNumber('RPC_BASE_DELAY_MS', 300),
  TRANSACTION_CONFIRM_TIMEOUT_MS: envNumber('TRANSACTION_CONFIRM_TIMEOUT_MS', 30000),
  TRANSACTION_CONFIRM_POLL_MS: envNumber('TRANSACTION_CONFIRM_POLL_MS', 1000),
  DASHBOARD_PORT: 3001,
  REMOTE_BRIDGE_URL: process.env.REMOTE_BRIDGE_URL || '',
  REMOTE_BRIDGE_TOKEN: process.env.REMOTE_BRIDGE_TOKEN || '',
  REMOTE_BRIDGE_AGENT_ID: process.env.REMOTE_BRIDGE_AGENT_ID || 'laptop-main',
  REMOTE_BRIDGE_POLL_MS: envNumber('REMOTE_BRIDGE_POLL_MS', 3000),
  HTTP_TIMEOUT_MS: 8000,
  DEXSCREENER_REQUEST_SPACING_MS: 350,
  DEXSCREENER_429_COOLDOWN_MS: 15000,
  DEXSCREENER_BOOST_CACHE_MS: 60000,
  DEXSCREENER_PRICE_CACHE_MS: 1000,
  DEXSCREENER_SOL_PRICE_CACHE_MS: 15000,
  DEXSCREENER_MAX_BOOST_LOOKUPS: 30,
  SOL_MINT: 'So11111111111111111111111111111111111111112',
  DEXSCREENER_TOKENS_URL: 'https://api.dexscreener.com/latest/dex/tokens/solana',
  DEXSCREENER_BOOSTS_URL: 'https://api.dexscreener.com/token-boosts/latest/v1',
  DEXSCREENER_TOKEN_URL: 'https://api.dexscreener.com/latest/dex/tokens',
  DEXSCREENER_TOKEN_BATCH_URL: 'https://api.dexscreener.com/tokens/v1/solana',
  GEMINI_URL: process.env.GEMINI_URL || `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
  JUPITER_QUOTE_URL: 'https://quote-api.jup.ag/v6/quote',
  JUPITER_SWAP_URL: 'https://quote-api.jup.ag/v6/swap'
};

export default CONFIG;
