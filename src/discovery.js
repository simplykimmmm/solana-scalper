import WebSocket from 'ws';
import CONFIG from '../config.js';
import { isTokenSafe } from './filters/rugCheck.js';
import logger from './logger.js';
import { callRpc } from './rpcClient.js';
import { fetchJson } from './utils/fetchJson.js';
import { retryWithBackoff } from './utils/retry.js';

const RAYDIUM_PROGRAM_ID = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';

export default class Discovery {
  constructor({ onCandidate }) {
    this.onCandidate = onCandidate;
    this.socket = null;
    this.closed = false;
    this.seenSignatures = new Set();
  }

  start() {
    if (!CONFIG.HELIUS_API_KEY) {
      return false;
    }

    this.closed = false;
    retryWithBackoff(() => this.connect(), 4, 300)
      .catch((error) => {
        logger.error('[discovery] Initial Helius connection failed:', { error: error.message });
        this.reconnect();
      });
    return true;
  }

  close() {
    this.closed = true;
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  async reconnect() {
    if (this.closed) return;

    setTimeout(() => {
      retryWithBackoff(() => this.connect(), 4, 2000)
        .catch((error) => {
          logger.error('[discovery] Helius reconnect failed:', { error: error.message });
          if (!this.closed) this.reconnect();
        });
    }, 2000);
  }

  connect() {
    return new Promise((resolve, reject) => {
      const url = `wss://atlas-mainnet.helius-rpc.com/?api-key=${encodeURIComponent(CONFIG.HELIUS_API_KEY)}`;
      const socket = new WebSocket(url);
      let settled = false;
      const settleTimeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.close();
          reject(new Error('Helius WebSocket connection timed out'));
        }
      }, CONFIG.HTTP_TIMEOUT_MS);

      socket.on('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(settleTimeout);
        this.socket = socket;
        socket.send(JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'logsSubscribe',
          params: [
            {
              mentions: [RAYDIUM_PROGRAM_ID]
            },
            {
              commitment: 'confirmed'
            }
          ]
        }));
        logger.info('[discovery] Helius Raydium pool subscription connected.');
        resolve();
      });

      socket.on('message', (message) => {
        this.handleMessage(message).catch((error) => {
          logger.error('[discovery] Helius message handler failed:', { error: error.message });
        });
      });

      socket.on('error', (error) => {
        logger.error('[discovery] Helius WebSocket error:', { error: error.message });
        if (!settled) {
          settled = true;
          clearTimeout(settleTimeout);
          reject(error);
        }
      });

      socket.on('close', () => {
        clearTimeout(settleTimeout);
        if (this.closed) return;
        logger.error('[discovery] Helius WebSocket disconnected; reconnecting.');
        this.reconnect();
      });
    });
  }

  async handleMessage(message) {
    const payload = JSON.parse(message.toString());
    const signature = payload?.params?.result?.value?.signature;
    if (!signature || this.seenSignatures.has(signature)) return;

    this.seenSignatures.add(signature);
    if (this.seenSignatures.size > 1000) {
      const [oldest] = this.seenSignatures;
      this.seenSignatures.delete(oldest);
    }

    await this.handlePoolSignature(signature);
  }

  async handlePoolSignature(signature) {
    const transaction = await retryWithBackoff(
      () => callRpc('getTransaction', [
        signature,
        {
          encoding: 'jsonParsed',
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0
        }
      ]),
      CONFIG.RPC_MAX_ATTEMPTS,
      CONFIG.RPC_BASE_DELAY_MS
    );

    const mint = this.extractPoolMint(transaction);
    if (!mint) return;
    if (!(await isTokenSafe(mint))) return;

    const candidate = await this.buildCandidate(mint, signature);
    await this.onCandidate(candidate);
  }

  extractPoolMint(transaction) {
    const balances = transaction?.meta?.postTokenBalances || [];
    const mints = balances
      .map((balance) => String(balance?.mint || ''))
      .filter((mint) => mint && mint !== CONFIG.SOL_MINT);

    return [...new Set(mints)][0] || '';
  }

  async buildCandidate(mint, signature) {
    const pair = await this.fetchBestDexScreenerPair(mint);
    const token = this.pickTradeToken(pair, mint);
    const volumeH1 = Number(pair?.volume?.h1 || 0);
    const averageVolumeH1 = this.estimateAverageVolumeH1(pair?.volume || {});
    const volumeSpike = averageVolumeH1 > 0 ? volumeH1 / averageVolumeH1 : 0;

    return {
      tokenAddress: mint,
      symbol: String(token?.symbol || mint.slice(0, 6)),
      priceUsd: Number(pair?.priceUsd || 0),
      liquidity: {
        usd: Number(pair?.liquidity?.usd || 0)
      },
      volumeH1,
      priceChange1m: Number(pair?.priceChange?.m1 || 0),
      priceChange5m: Number(pair?.priceChange?.m5 || 0),
      pairCreatedAt: Number(pair?.pairCreatedAt || Date.now()),
      pairAddress: String(pair?.pairAddress || signature),
      dexId: String(pair?.dexId || 'raydium'),
      volumeSpike: Number(volumeSpike.toFixed(2)),
      source: 'helius-raydium',
      signature
    };
  }

  async fetchBestDexScreenerPair(mint) {
    try {
      const data = await retryWithBackoff(async () => {
        return fetchJson(`${CONFIG.DEXSCREENER_TOKEN_BATCH_URL}/${encodeURIComponent(mint)}`);
      });

      const pairs = Array.isArray(data) ? data : Array.isArray(data?.pairs) ? data.pairs : [];
      const solanaPairs = pairs.filter((pair) => pair?.chainId === 'solana');
      solanaPairs.sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0));
      return solanaPairs[0] || null;
    } catch (error) {
      logger.error(`[discovery] Failed to enrich ${mint} from DexScreener:`, { error: error.message });
      return null;
    }
  }

  pickTradeToken(pair, mint) {
    const base = pair?.baseToken || {};
    const quote = pair?.quoteToken || {};
    if (base.address === mint) return base;
    if (quote.address === mint) return quote;
    return { address: mint, symbol: mint.slice(0, 6) };
  }

  estimateAverageVolumeH1(volume) {
    const h24 = Number(volume.h24 || 0);
    if (h24 > 0) return h24 / 24;

    const h6 = Number(volume.h6 || 0);
    if (h6 > 0) return h6 / 6;

    const h1 = Number(volume.h1 || 0);
    return h1 > 0 ? h1 : 0;
  }
}
