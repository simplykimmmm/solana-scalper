import fetch from 'node-fetch';
import bs58 from 'bs58';
import { VersionedTransaction } from '@solana/web3.js';
import CONFIG from '../config.js';
import logger from './logger.js';
import { callRpc } from './rpcClient.js';
import { retryWithBackoff } from './utils/retry.js';

const JITO_BUNDLE_URL = 'https://mainnet.block-engine.jito.wtf/api/v1/bundles';

export async function getComputeUnitPrice() {
  if (CONFIG.SIMULATION_MODE) {
    return CONFIG.PRIORITY_FEE;
  }

  try {
    const fees = await retryWithBackoff(
      () => callRpc('getRecentPrioritizationFees', []),
      CONFIG.RPC_MAX_ATTEMPTS,
      CONFIG.RPC_BASE_DELAY_MS
    );
    const values = (Array.isArray(fees) ? fees : [])
      .map((fee) => Number(fee?.prioritizationFee || 0))
      .filter((fee) => Number.isFinite(fee) && fee > 0)
      .sort((a, b) => a - b);

    if (!values.length) return CONFIG.PRIORITY_FEE;

    const index = Math.floor((values.length - 1) * 0.75);
    return Math.max(1, Math.floor(values[index]));
  } catch (error) {
    logger.error('[swap] Failed to fetch prioritization fees; using configured fallback:', error.message);
    return CONFIG.PRIORITY_FEE;
  }
}

export async function getQuote(inputMint, outputMint, amount) {
  return retryWithBackoff(async () => {
    const url = new URL(CONFIG.JUPITER_QUOTE_URL);
    url.searchParams.set('inputMint', inputMint);
    url.searchParams.set('outputMint', outputMint);
    url.searchParams.set('amount', String(amount));
    url.searchParams.set('slippageBps', String(CONFIG.SLIPPAGE_BPS));
    url.searchParams.set('onlyDirectRoutes', 'false');

    const data = await fetchJson(url.toString());
    if (!data?.outAmount) {
      throw new Error(`Quote missing outAmount for ${inputMint} -> ${outputMint}`);
    }
    return data;
  });
}

export async function buildSwapTransaction(quoteResponse, userPublicKey, computeUnitPrice) {
  return retryWithBackoff(async () => {
    const data = await fetchJson(CONFIG.JUPITER_SWAP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey,
        computeUnitPriceMicroLamports: Number(computeUnitPrice || CONFIG.PRIORITY_FEE),
        dynamicComputeUnitLimit: true,
        dynamicComputeUnits: true
      })
    });

    if (!data?.swapTransaction) {
      throw new Error('Jupiter swap response missing swapTransaction');
    }

    return data;
  });
}

export async function signSendAndConfirmSwap({ wallet, swapResponse }) {
  if (CONFIG.SIMULATION_MODE) {
    return `SIM-SWAP-${Date.now()}`;
  }

  const swapTransactionBuffer = Buffer.from(swapResponse.swapTransaction, 'base64');
  const transaction = VersionedTransaction.deserialize(swapTransactionBuffer);
  transaction.sign([wallet]);

  const serializedTransaction = transaction.serialize();
  const txSignature = bs58.encode(transaction.signatures[0]);

  if (CONFIG.JITO_ENABLED) {
    try {
      await submitJitoBundle(serializedTransaction);
      logger.info(`[swap] Submitted Jito bundle for ${txSignature}.`);
      await waitForSignatureConfirmation(txSignature);
      return txSignature;
    } catch (error) {
      logger.error('[swap] Jito bundle failed or timed out; falling back to normal sendTransaction:', error.message);
    }
  }

  return sendTransactionAndConfirm(serializedTransaction, txSignature);
}

async function sendTransactionAndConfirm(serializedTransaction, txSignature) {
  const encodedTransaction = Buffer.from(serializedTransaction).toString('base64');
  const signature = await retryWithBackoff(
    () => callRpc('sendTransaction', [
      encodedTransaction,
      {
        encoding: 'base64',
        skipPreflight: true,
        maxRetries: 3
      }
    ]),
    CONFIG.RPC_MAX_ATTEMPTS,
    CONFIG.RPC_BASE_DELAY_MS
  );

  const confirmedSignature = signature || txSignature;
  await waitForSignatureConfirmation(confirmedSignature);
  return confirmedSignature;
}

async function waitForSignatureConfirmation(signature) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < CONFIG.TRANSACTION_CONFIRM_TIMEOUT_MS) {
    const statusResponse = await retryWithBackoff(
      () => callRpc('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]),
      CONFIG.RPC_MAX_ATTEMPTS,
      CONFIG.RPC_BASE_DELAY_MS
    );
    const status = statusResponse?.value?.[0];

    if (status?.err) {
      throw new Error(`Transaction confirmation error: ${JSON.stringify(status.err)}`);
    }

    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, CONFIG.TRANSACTION_CONFIRM_POLL_MS));
  }

  throw new Error(`Timed out waiting for confirmation of ${signature}`);
}

async function submitJitoBundle(serializedTransaction) {
  const encodedTransaction = Buffer.from(serializedTransaction).toString('base64');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  try {
    const response = await fetch(JITO_BUNDLE_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'sendBundle',
        params: [[encodedTransaction]]
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Jito HTTP ${response.status}: ${text.slice(0, 200)}`);
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

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.HTTP_TIMEOUT_MS);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status} for ${safeUrlForLog(url)}: ${text.slice(0, 200)}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function safeUrlForLog(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(url);
  }
}
