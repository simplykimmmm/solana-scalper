import fetch from 'node-fetch';
import CONFIG from '../config.js';
import logger from './logger.js';
import { retryWithBackoff } from './utils/retry.js';

export async function callRpc(method, params = []) {
  if (CONFIG.SIMULATION_MODE) {
    logger.debug(`[rpc] Simulation mode active; skipping RPC method ${method}.`);
    return null;
  }

  const urls = [...new Set([
    CONFIG.PRIMARY_RPC_URL,
    CONFIG.FALLBACK_RPC_URL
  ].filter(Boolean))];

  let lastError = new Error('No RPC URLs configured.');

  for (const url of urls) {
    try {
      return await retryWithBackoff(
        () => postRpc(url, method, params),
        CONFIG.RPC_MAX_ATTEMPTS,
        CONFIG.RPC_BASE_DELAY_MS
      );
    } catch (error) {
      lastError = error;
      logger.error(`[rpc] ${method} failed on ${safeRpcUrl(url)}:`, { error: error.message });
    }
  }

  throw lastError;
}

async function postRpc(url, method, params) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.HTTP_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method,
        params
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    }

    const data = await response.json();
    if (data?.error) {
      throw new Error(data.error.message || JSON.stringify(data.error));
    }

    return data?.result;
  } finally {
    clearTimeout(timeout);
  }
}

function safeRpcUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(url);
  }
}
