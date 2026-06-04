import WebSocket from 'ws';
import CONFIG from '../config.js';
import logger from './logger.js';
import { fetchJson } from './utils/fetchJson.js';

export default class Scanner {
  constructor() {
    try {
      this.lastCandidates = [];
      this.feedSocket = null;
      this.feedEvents = [];
      this.boostPairsCache = [];
      this.boostPairsCacheExpiresAt = 0;
      this.nextDexScreenerRequestAt = 0;
      this.dexScreenerCooldownUntil = 0;
      this.lastRateLimitLogAt = 0;
    } catch (error) {
      logger.error('[scanner] Failed to initialize scanner:', { error: error.message });
    }
  }

  startOptionalWebSocketFeed(url = process.env.DEXSCREENER_WS_URL) {
    try {
      if (!url) {
        logger.info('[scanner] No DexScreener WebSocket URL configured; using public polling only.');
        return;
      }

      this.feedSocket = new WebSocket(url);
      this.feedSocket.on('open', () => {
        try {
          logger.info('[scanner] DexScreener WebSocket feed connected.');
        } catch (error) {
          logger.error('[scanner] WebSocket open handler failed:', { error: error.message });
        }
      });
      this.feedSocket.on('message', (message) => {
        try {
          const parsed = JSON.parse(message.toString());
          this.feedEvents.push(parsed);
          if (this.feedEvents.length > 100) this.feedEvents.shift();
        } catch (error) {
          logger.error('[scanner] Failed to parse WebSocket message:', { error: error.message });
        }
      });
      this.feedSocket.on('error', (error) => {
        try {
          logger.error('[scanner] DexScreener WebSocket error:', { error: error.message });
        } catch (handlerError) {
          logger.error('[scanner] WebSocket error handler failed:', { error: handlerError.message });
        }
      });
      this.feedSocket.on('close', () => {
        try {
          logger.info('[scanner] DexScreener WebSocket feed closed.');
        } catch (error) {
          logger.error('[scanner] WebSocket close handler failed:', { error: error.message });
        }
      });
    } catch (error) {
      logger.error('[scanner] Failed to start optional WebSocket feed:', { error: error.message });
    }
  }

  async scan() {
    try {
      const tokenPairs = await this.fetchLatestTokenPairs();
      const boostPairs = await this.fetchBoostedTokenPairs();
      const candidates = this.extractCandidates([...tokenPairs, ...boostPairs]);
      this.lastCandidates = candidates;
      return candidates;
    } catch (error) {
      logger.error('[scanner] Scan failed:', { error: error.message });
      return [];
    }
  }

  async fetchLatestTokenPairs() {
    try {
      const data = await this.requestDexScreenerJson(CONFIG.DEXSCREENER_TOKENS_URL);
      return Array.isArray(data?.pairs) ? data.pairs : [];
    } catch (error) {
      logger.error('[scanner] Failed to fetch latest DexScreener token pairs:', { error: error.message });
      return [];
    }
  }

  async fetchBoostedTokenPairs() {
    try {
      if (Date.now() < this.boostPairsCacheExpiresAt) {
        return this.boostPairsCache;
      }

      const data = await this.requestDexScreenerJson(CONFIG.DEXSCREENER_BOOSTS_URL);
      if (!data && this.boostPairsCache.length) {
        return this.boostPairsCache;
      }

      const boosts = Array.isArray(data) ? data : [];
      const solanaBoostAddresses = [...new Set(boosts
        .filter((boost) => boost?.chainId === 'solana' && boost?.tokenAddress)
        .map((boost) => boost.tokenAddress))]
        .slice(0, CONFIG.DEXSCREENER_MAX_BOOST_LOOKUPS);

      const pairs = await this.fetchTokenPairsByAddresses(solanaBoostAddresses);
      this.boostPairsCache = pairs;
      this.boostPairsCacheExpiresAt = Date.now() + CONFIG.DEXSCREENER_BOOST_CACHE_MS;
      return pairs;
    } catch (error) {
      logger.error('[scanner] Failed to fetch boosted DexScreener tokens:', { error: error.message });
      return [];
    }
  }

  async fetchTokenPairsByAddresses(tokenAddresses) {
    try {
      if (!Array.isArray(tokenAddresses) || !tokenAddresses.length) {
        return [];
      }

      const allPairs = [];
      const chunks = this.chunk(tokenAddresses, 30);

      for (const chunk of chunks) {
        try {
          const url = `${CONFIG.DEXSCREENER_TOKEN_BATCH_URL}/${chunk.join(',')}`;
          const data = await this.requestDexScreenerJson(url);
          if (Array.isArray(data)) {
            allPairs.push(...data);
          } else if (Array.isArray(data?.pairs)) {
            allPairs.push(...data.pairs);
          }
        } catch (error) {
          logger.error('[scanner] Failed to fetch boosted token batch:', { error: error.message });
        }
      }

      return allPairs;
    } catch (error) {
      logger.error('[scanner] Failed to fetch token pairs by addresses:', { error: error.message });
      return [];
    }
  }

  async requestDexScreenerJson(url) {
    try {
      await this.waitForDexScreenerSlot();
      return await fetchJson(url);
    } catch (error) {
      if (error.status === 429) {
        this.handleRateLimit(error.retryAfter, url);
      }
      logger.error(`[scanner] Failed to fetch JSON from ${url}:`, { error: error.message });
      return null;
    }
  }

  async waitForDexScreenerSlot() {
    try {
      const now = Date.now();
      if (now < this.dexScreenerCooldownUntil) {
        await this.sleep(this.dexScreenerCooldownUntil - now);
      }

      const waitMs = Math.max(0, this.nextDexScreenerRequestAt - Date.now());
      if (waitMs > 0) {
        await this.sleep(waitMs);
      }

      this.nextDexScreenerRequestAt = Date.now() + CONFIG.DEXSCREENER_REQUEST_SPACING_MS;
    } catch (error) {
      logger.error('[scanner] Failed while waiting for DexScreener request slot:', { error: error.message });
    }
  }

  handleRateLimit(retryAfterHeader, url) {
    try {
      const retryAfter = Number(retryAfterHeader || 0);
      const cooldownMs = retryAfter > 0 ? retryAfter * 1000 : CONFIG.DEXSCREENER_429_COOLDOWN_MS;
      this.dexScreenerCooldownUntil = Date.now() + cooldownMs;

      if (Date.now() - this.lastRateLimitLogAt > 5000) {
        logger.error(`[scanner] DexScreener rate limit hit; cooling down ${Math.ceil(cooldownMs / 1000)}s after ${this.safeUrlForLog(url)}`);
        this.lastRateLimitLogAt = Date.now();
      }
    } catch (error) {
      logger.error('[scanner] Failed to handle DexScreener rate limit:', { error: error.message });
    }
  }

  sleep(ms) {
    try {
      return new Promise((resolve) => setTimeout(resolve, ms));
    } catch (error) {
      logger.error('[scanner] Failed to sleep:', { error: error.message });
      return Promise.resolve();
    }
  }

  safeUrlForLog(url) {
    try {
      const parsed = new URL(url);
      return `${parsed.origin}${parsed.pathname}`;
    } catch (error) {
      logger.error('[scanner] Failed to sanitize URL for log:', { error: error.message });
      return String(url);
    }
  }

  chunk(items, size) {
    try {
      const chunks = [];
      for (let index = 0; index < items.length; index += size) {
        chunks.push(items.slice(index, index + size));
      }
      return chunks;
    } catch (error) {
      logger.error('[scanner] Failed to chunk items:', { error: error.message });
      return [];
    }
  }

  extractCandidates(pairs) {
    try {
      const byToken = new Map();

      for (const pair of pairs) {
        try {
          if (!pair || pair.chainId !== 'solana') continue;

          const token = this.pickTradeToken(pair);
          if (!token?.address) continue;

          const volumeH1 = Number(pair.volume?.h1 || 0);
          const averageVolumeH1 = this.estimateAverageVolumeH1(pair.volume || {});
          const volumeSpike = averageVolumeH1 > 0 ? volumeH1 / averageVolumeH1 : 0;

          if (volumeSpike <= CONFIG.VOLUME_SPIKE_MULTIPLIER) continue;

          const candidate = {
            tokenAddress: token.address,
            symbol: String(token.symbol || 'UNKNOWN'),
            priceUsd: Number(pair.priceUsd || 0),
            liquidity: {
              usd: Number(pair.liquidity?.usd || 0)
            },
            volumeH1,
            priceChange1m: Number(pair.priceChange?.m1 || 0),
            priceChange5m: Number(pair.priceChange?.m5 || 0),
            pairCreatedAt: Number(pair.pairCreatedAt || 0),
            pairAddress: String(pair.pairAddress || ''),
            dexId: String(pair.dexId || ''),
            volumeSpike: Number(volumeSpike.toFixed(2))
          };

          const previous = byToken.get(candidate.tokenAddress);
          if (!previous || candidate.liquidity.usd > previous.liquidity.usd) {
            byToken.set(candidate.tokenAddress, candidate);
          }
        } catch (error) {
          logger.error('[scanner] Failed to normalize pair:', { error: error.message });
        }
      }

      return [...byToken.values()];
    } catch (error) {
      logger.error('[scanner] Failed to extract candidates:', { error: error.message });
      return [];
    }
  }

  pickTradeToken(pair) {
    try {
      const base = pair?.baseToken || {};
      const quote = pair?.quoteToken || {};
      if (base.address === CONFIG.SOL_MINT && quote.address) return quote;
      return base.address ? base : quote;
    } catch (error) {
      logger.error('[scanner] Failed to pick trade token:', { error: error.message });
      return null;
    }
  }

  estimateAverageVolumeH1(volume) {
    try {
      const h24 = Number(volume.h24 || 0);
      if (h24 > 0) return h24 / 24;

      const h6 = Number(volume.h6 || 0);
      if (h6 > 0) return h6 / 6;

      const h1 = Number(volume.h1 || 0);
      return h1 > 0 ? h1 : 0;
    } catch (error) {
      logger.error('[scanner] Failed to estimate average volume:', { error: error.message });
      return 0;
    }
  }

  close() {
    try {
      if (this.feedSocket) {
        this.feedSocket.close();
      }
    } catch (error) {
      logger.error('[scanner] Failed to close WebSocket feed:', { error: error.message });
    }
  }
}
