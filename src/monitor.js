import fetch from 'node-fetch';
import CONFIG from '../config.js';
import { insertTrade } from './db.js';
import logger from './logger.js';
import { callRpc } from './rpcClient.js';
import { closePosition as closeStatePosition, recordTrade } from './state.js';

export default class Monitor {
  constructor(executor, connection) {
    try {
      this.executor = executor;
      this.connection = connection;
      this.positions = new Map();
      this.closedTrades = [];
      this.openPositionLog = [];
      this.maxOpenPositionLogEntries = 100;
      this.totalPnlSol = 0;
      this.interval = null;
      this.isTicking = false;
      this.solPriceUsd = 0;
      this.solPriceUpdatedAt = 0;
      this.priceCache = new Map();
      this.nextDexScreenerRequestAt = 0;
      this.dexScreenerCooldownUntil = 0;
      this.lastRateLimitLogAt = 0;
    } catch (error) {
      logger.error('[monitor] Failed to initialize monitor:', error.message);
    }
  }

  start() {
    try {
      if (this.interval) return;
      this.interval = setInterval(() => {
        try {
          if (this.isTicking) return;
          this.isTicking = true;
          this.tick()
            .catch((error) => {
              logger.error('[monitor] Tick promise failed:', error.message);
            })
            .finally(() => {
              try {
                this.isTicking = false;
              } catch (error) {
                logger.error('[monitor] Failed to clear tick guard:', error.message);
              }
            });
        } catch (error) {
          logger.error('[monitor] Tick scheduling failed:', error.message);
          this.isTicking = false;
        }
      }, 1000);
    } catch (error) {
      logger.error('[monitor] Failed to start monitor:', error.message);
    }
  }

  stop() {
    try {
      if (this.interval) {
        clearInterval(this.interval);
        this.interval = null;
      }
    } catch (error) {
      logger.error('[monitor] Failed to stop monitor:', error.message);
    }
  }

  addPosition(candidate, buyResult) {
    try {
      const entryPrice = Number(buyResult.entryPrice || candidate.priceUsd || 0);
      const position = {
        tokenAddress: candidate.tokenAddress,
        symbol: candidate.symbol,
        entryPrice,
        currentPrice: entryPrice,
        highestPrice: entryPrice,
        entryPriceChange5m: Number(candidate.priceChange5m || 0),
        entryVolumeSpike: Number(candidate.volumeSpike || 0),
        momentumExtendedHold: this.isMomentumHoldCandidate(candidate),
        amountOut: String(buyResult.amountOut || '0'),
        entryTime: Date.now(),
        txSignature: buyResult.txSignature,
        pnlPercent: 0,
        lastUpdate: Date.now()
      };
      this.positions.set(candidate.tokenAddress, position);
      this.recordOpenPositionLog('OPEN', position, entryPrice);
      return position;
    } catch (error) {
      logger.error('[monitor] Failed to add position:', error.message);
      return null;
    }
  }

  async tick() {
    try {
      await this.updateSolPriceUsd();
      const checks = [...this.positions.values()].map(async (position) => {
        try {
          await this.checkPosition(position);
        } catch (error) {
          logger.error(`[monitor] Position check failed for ${position.symbol}:`, error.message);
        }
      });
      await Promise.all(checks);
    } catch (error) {
      logger.error('[monitor] Monitor tick failed:', error.message);
    }
  }

  async checkPosition(position) {
    try {
      const currentPrice = await this.fetchCurrentPrice(position.tokenAddress);
      if (!currentPrice) {
        return;
      }

      position.currentPrice = Number(currentPrice);
      position.highestPrice = Math.max(Number(position.highestPrice || position.entryPrice || 0), Number(currentPrice));
      position.pnlPercent = this.calculatePnlPercent(position.entryPrice, currentPrice);
      position.lastUpdate = Date.now();
      this.recordOpenPositionLog('UPDATE', position, currentPrice);

      const takeProfitPercent = position.momentumExtendedHold
        ? CONFIG.MOMENTUM_TAKE_PROFIT_PERCENT
        : CONFIG.TAKE_PROFIT_PERCENT;
      const maxHoldSeconds = this.getPositionMaxHoldSeconds(position);
      const takeProfitPrice = position.entryPrice * (1 + takeProfitPercent / 100);
      const stopLossPrice = position.entryPrice * (1 - CONFIG.STOP_LOSS_PERCENT / 100);
      const heldSeconds = (Date.now() - position.entryTime) / 1000;
      const trailingStopPrice = this.getMomentumTrailingStopPrice(position);

      if (currentPrice >= takeProfitPrice) {
        await this.closePosition(position.tokenAddress, 'take_profit');
      } else if (currentPrice <= stopLossPrice) {
        await this.closePosition(position.tokenAddress, 'stop_loss');
      } else if (trailingStopPrice && currentPrice <= trailingStopPrice) {
        await this.closePosition(position.tokenAddress, 'momentum_trailing_stop');
      } else if (heldSeconds >= maxHoldSeconds) {
        await this.closePosition(position.tokenAddress, 'max_hold');
      }
    } catch (error) {
      logger.error(`[monitor] Failed to check position ${position?.symbol || 'unknown'}:`, error.message);
    }
  }

  async closePosition(tokenAddress, reason = 'manual') {
    try {
      const position = this.positions.get(tokenAddress);
      if (!position) {
        return { success: false, reason: 'position not found' };
      }

      const currentPrice = Number(position.currentPrice || (await this.fetchCurrentPrice(tokenAddress)) || 0);
      const pnlPercent = this.calculatePnlPercent(position.entryPrice, currentPrice);
      const sellResult = await this.executor.sell(position, currentPrice, reason);
      const precision = this.buildPositionPrecision(position, currentPrice);
      const pnlSol = precision.pnlSol;

      if (!sellResult.success) {
        this.recordOpenPositionLog(`EXIT_FAILED_${reason}`, position, currentPrice);
        return sellResult;
      }

      const trade = {
        tokenAddress: position.tokenAddress,
        symbol: position.symbol,
        entryPrice: Number(position.entryPrice),
        currentPrice,
        priceDeltaUsd: Number(precision.priceDeltaUsd),
        pnlPercent: Number(pnlPercent),
        pnlSol: Number(pnlSol),
        pnlUsd: Number(pnlSol * this.solPriceUsd),
        heldMs: Number(precision.heldMs),
        heldSeconds: Number(precision.heldSeconds),
        reason,
        entryTime: position.entryTime,
        exitTime: Date.now(),
        buyTxSignature: position.txSignature,
        sellTxSignature: sellResult.txSignature,
        success: Boolean(sellResult.success)
      };

      this.totalPnlSol += pnlSol;
      insertTrade({
        mint: position.tokenAddress,
        side: 'sell',
        amount_sol: Math.max(0, CONFIG.TRADE_SIZE_SOL + pnlSol),
        price_usd: currentPrice,
        tx_signature: sellResult.txSignature,
        timestamp: trade.exitTime
      });
      recordTrade(pnlSol);
      closeStatePosition(tokenAddress);
      this.closedTrades.unshift(trade);
      this.closedTrades = this.closedTrades.slice(0, 20);
      this.recordOpenPositionLog(`EXIT_${reason}`, position, currentPrice);
      this.positions.delete(tokenAddress);
      this.logTradeAction(`CLOSE_${reason}`, position.symbol, currentPrice, `${pnlPercent.toFixed(2)}%`);
      return sellResult;
    } catch (error) {
      logger.error(`[monitor] Failed to close position ${tokenAddress}:`, error.message);
      return { success: false, reason: error.message };
    }
  }

  async closeAllPositions(reason = 'shutdown') {
    try {
      const tokenAddresses = [...this.positions.keys()];
      for (const tokenAddress of tokenAddresses) {
        try {
          await this.closePosition(tokenAddress, reason);
        } catch (error) {
          logger.error(`[monitor] Failed to close ${tokenAddress} during ${reason}:`, error.message);
        }
      }
    } catch (error) {
      logger.error('[monitor] Failed to close all positions:', error.message);
    }
  }

  async fetchCurrentPrice(tokenAddress) {
    try {
      const cached = this.priceCache.get(tokenAddress);
      const cacheMs = tokenAddress === CONFIG.SOL_MINT
        ? CONFIG.DEXSCREENER_SOL_PRICE_CACHE_MS
        : CONFIG.DEXSCREENER_PRICE_CACHE_MS;

      if (cached && Date.now() - cached.updatedAt < cacheMs) {
        return Number(cached.price || 0);
      }

      const data = await this.fetchJson(`${CONFIG.DEXSCREENER_TOKEN_BATCH_URL}/${tokenAddress}`);
      const pairs = Array.isArray(data) ? data : Array.isArray(data?.pairs) ? data.pairs : [];
      const solanaPairs = pairs.filter((pair) => pair?.chainId === 'solana' && Number(pair.priceUsd || 0) > 0);
      solanaPairs.sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0));
      const price = Number(solanaPairs[0]?.priceUsd || 0);

      if (price > 0) {
        this.priceCache.set(tokenAddress, {
          price,
          updatedAt: Date.now()
        });
      }

      return price;
    } catch (error) {
      logger.error(`[monitor] Failed to fetch current price for ${tokenAddress}:`, error.message);
      return 0;
    }
  }

  async updateSolPriceUsd() {
    try {
      if (this.solPriceUsd > 0 && Date.now() - this.solPriceUpdatedAt < CONFIG.DEXSCREENER_SOL_PRICE_CACHE_MS) {
        return;
      }

      const price = await this.fetchCurrentPrice(CONFIG.SOL_MINT);
      if (price > 0) {
        this.solPriceUsd = Number(price);
        this.solPriceUpdatedAt = Date.now();
      }
    } catch (error) {
      logger.error('[monitor] Failed to update SOL price:', error.message);
    }
  }

  async fetchJson(url) {
    try {
      await this.waitForDexScreenerSlot();
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        try {
          controller.abort();
        } catch (error) {
          logger.error('[monitor] Failed to abort timed-out request:', error.message);
        }
      }, CONFIG.HTTP_TIMEOUT_MS);

      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (response.status === 429) {
        this.handleRateLimit(response, url);
        return null;
      }

      if (!response.ok) {
        logger.error(`[monitor] HTTP ${response.status} for ${this.safeUrlForLog(url)}`);
        return null;
      }

      return await response.json();
    } catch (error) {
      logger.error(`[monitor] Failed to fetch JSON from ${url}:`, error.message);
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
      logger.error('[monitor] Failed while waiting for DexScreener request slot:', error.message);
    }
  }

  handleRateLimit(response, url) {
    try {
      const retryAfter = Number(response.headers.get('retry-after') || 0);
      const cooldownMs = retryAfter > 0 ? retryAfter * 1000 : CONFIG.DEXSCREENER_429_COOLDOWN_MS;
      this.dexScreenerCooldownUntil = Date.now() + cooldownMs;

      if (Date.now() - this.lastRateLimitLogAt > 5000) {
        logger.error(`[monitor] DexScreener rate limit hit; cooling down ${Math.ceil(cooldownMs / 1000)}s after ${this.safeUrlForLog(url)}`);
        this.lastRateLimitLogAt = Date.now();
      }
    } catch (error) {
      logger.error('[monitor] Failed to handle DexScreener rate limit:', error.message);
    }
  }

  sleep(ms) {
    try {
      return new Promise((resolve) => setTimeout(resolve, ms));
    } catch (error) {
      logger.error('[monitor] Failed to sleep:', error.message);
      return Promise.resolve();
    }
  }

  safeUrlForLog(url) {
    try {
      const parsed = new URL(url);
      return `${parsed.origin}${parsed.pathname}`;
    } catch (error) {
      logger.error('[monitor] Failed to sanitize URL for log:', error.message);
      return String(url);
    }
  }

  calculatePnlPercent(entryPrice, currentPrice) {
    try {
      const entry = Number(entryPrice || 0);
      const current = Number(currentPrice || 0);
      if (!entry) return 0;
      return ((current - entry) / entry) * 100;
    } catch (error) {
      logger.error('[monitor] Failed to calculate PnL percent:', error.message);
      return 0;
    }
  }

  async getStatus() {
    try {
      const balanceLamports = await this.getSolBalanceLamports();
      const totalTrades = this.closedTrades.length;
      const wins = this.closedTrades.filter((trade) => Number(trade.pnlPercent || 0) > 0).length;
      const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
      const openPositions = this.getOpenPositionsSnapshot();
      const unrealizedPnlSol = openPositions.reduce((total, position) => {
        try {
          return total + Number(position.pnlSol || 0);
        } catch (error) {
          logger.error('[monitor] Failed while summing unrealized PnL:', error.message);
          return total;
        }
      }, 0);
      const totalExactPnlSol = Number(this.totalPnlSol) + Number(unrealizedPnlSol);

      return {
        simulationMode: Boolean(CONFIG.SIMULATION_MODE),
        solBalance: Number(balanceLamports / 1e9),
        solPriceUsd: Number(this.solPriceUsd || 0),
        totalTrades,
        winRate: Number(winRate),
        totalPnlSol: Number(totalExactPnlSol),
        totalPnlUsd: Number(totalExactPnlSol * (this.solPriceUsd || 0)),
        realizedPnlSol: Number(this.totalPnlSol),
        realizedPnlUsd: Number(this.totalPnlSol * (this.solPriceUsd || 0)),
        unrealizedPnlSol: Number(unrealizedPnlSol),
        unrealizedPnlUsd: Number(unrealizedPnlSol * (this.solPriceUsd || 0)),
        openPositions,
        openPositionLog: this.openPositionLog.slice(0, this.maxOpenPositionLogEntries),
        closedTrades: this.closedTrades.slice(0, 20)
      };
    } catch (error) {
      logger.error('[monitor] Failed to build status payload:', error.message);
      return {
        simulationMode: Boolean(CONFIG.SIMULATION_MODE),
        solBalance: 0,
        solPriceUsd: Number(this.solPriceUsd || 0),
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
        closedTrades: []
      };
    }
  }

  async getSolBalanceLamports() {
    try {
      if (!this.executor?.wallet?.publicKey) return 0;
      if (CONFIG.SIMULATION_MODE) return 0;
      const balance = await callRpc('getBalance', [
        this.executor.wallet.publicKey.toBase58(),
        { commitment: 'confirmed' }
      ]);
      return Number(balance?.value || 0);
    } catch (error) {
      logger.error('[monitor] Failed to fetch SOL balance:', error.message);
      return 0;
    }
  }

  getOpenPositionsSnapshot() {
    try {
      return [...this.positions.values()].map((position) => {
        try {
          const precision = this.buildPositionPrecision(position, position.currentPrice);
          return {
            id: `${position.tokenAddress}-${position.entryTime}`,
            tokenAddress: position.tokenAddress,
            symbol: position.symbol,
            entryPrice: Number(position.entryPrice),
            currentPrice: Number(position.currentPrice || 0),
            highestPrice: Number(position.highestPrice || position.currentPrice || 0),
            momentumExtendedHold: Boolean(position.momentumExtendedHold),
            priceDeltaUsd: Number(precision.priceDeltaUsd),
            pnlPercent: Number(precision.pnlPercent),
            pnlSol: Number(precision.pnlSol),
            pnlUsd: Number(precision.pnlUsd),
            timeHeldMs: Number(precision.heldMs),
            timeHeldSeconds: Number(precision.heldSeconds),
            entryTime: Number(position.entryTime),
            lastUpdate: Number(position.lastUpdate || position.entryTime),
            txSignature: position.txSignature
          };
        } catch (error) {
          logger.error('[monitor] Failed to snapshot position:', error.message);
          return null;
        }
      }).filter(Boolean);
    } catch (error) {
      logger.error('[monitor] Failed to snapshot open positions:', error.message);
      return [];
    }
  }

  logTradeAction(action, token, price, pnl) {
    try {
      const timestamp = new Date().toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
      logger.info(`[${timestamp}] ${action} ${token} ${Number(price || 0).toFixed(10)} ${pnl}`);
    } catch (error) {
      logger.error('[monitor] Failed to log trade action:', error.message);
    }
  }

  buildPositionPrecision(position, currentPrice = position?.currentPrice) {
    try {
      const entryPrice = Number(position?.entryPrice || 0);
      const price = Number(currentPrice || 0);
      const priceDeltaUsd = price - entryPrice;
      const pnlPercent = this.calculatePnlPercent(entryPrice, price);
      const pnlSol = CONFIG.TRADE_SIZE_SOL * (pnlPercent / 100);
      const pnlUsd = pnlSol * Number(this.solPriceUsd || 0);
      const heldMs = Date.now() - Number(position?.entryTime || Date.now());

      return {
        priceDeltaUsd: Number(priceDeltaUsd),
        pnlPercent: Number(pnlPercent),
        pnlSol: Number(pnlSol),
        pnlUsd: Number(pnlUsd),
        heldMs: Number(heldMs),
        heldSeconds: Number(heldMs / 1000)
      };
    } catch (error) {
      logger.error('[monitor] Failed to build position precision data:', error.message);
      return {
        priceDeltaUsd: 0,
        pnlPercent: 0,
        pnlSol: 0,
        pnlUsd: 0,
        heldMs: 0,
        heldSeconds: 0
      };
    }
  }

  recordOpenPositionLog(action, position, currentPrice = position?.currentPrice) {
    try {
      const precision = this.buildPositionPrecision(position, currentPrice);
      this.openPositionLog.unshift({
        timestamp: Date.now(),
        action: String(action),
        tokenAddress: String(position?.tokenAddress || ''),
        symbol: String(position?.symbol || 'UNKNOWN'),
        entryPrice: Number(position?.entryPrice || 0),
        currentPrice: Number(currentPrice || 0),
        highestPrice: Number(position?.highestPrice || currentPrice || 0),
        momentumExtendedHold: Boolean(position?.momentumExtendedHold),
        priceDeltaUsd: Number(precision.priceDeltaUsd),
        pnlPercent: Number(precision.pnlPercent),
        pnlSol: Number(precision.pnlSol),
        pnlUsd: Number(precision.pnlUsd),
        heldMs: Number(precision.heldMs),
        txSignature: String(position?.txSignature || '')
      });
      this.openPositionLog = this.openPositionLog.slice(0, this.maxOpenPositionLogEntries);
    } catch (error) {
      logger.error('[monitor] Failed to record open position log:', error.message);
    }
  }

  isMomentumHoldCandidate(candidate) {
    try {
      return Number(candidate?.priceChange5m || 0) >= CONFIG.MOMENTUM_MIN_PRICE_CHANGE_5M
        && Number(candidate?.volumeSpike || 0) >= CONFIG.MOMENTUM_MIN_VOLUME_SPIKE;
    } catch (error) {
      logger.error('[monitor] Failed to classify momentum hold candidate:', error.message);
      return false;
    }
  }

  getPositionMaxHoldSeconds(position) {
    try {
      if (!position?.momentumExtendedHold) {
        return CONFIG.MAX_HOLD_SECONDS;
      }

      if (Number(position.pnlPercent || 0) < 0) {
        return CONFIG.MAX_HOLD_SECONDS;
      }

      return CONFIG.MOMENTUM_EXTENDED_HOLD_SECONDS;
    } catch (error) {
      logger.error('[monitor] Failed to calculate max hold seconds:', error.message);
      return CONFIG.MAX_HOLD_SECONDS;
    }
  }

  getMomentumTrailingStopPrice(position) {
    try {
      if (!position?.momentumExtendedHold) return 0;

      const pnlPercent = Number(position.pnlPercent || 0);
      if (pnlPercent < CONFIG.MOMENTUM_MIN_PROFIT_FOR_TRAILING_PERCENT) {
        return 0;
      }

      const highestPrice = Number(position.highestPrice || 0);
      if (!highestPrice) return 0;

      return highestPrice * (1 - CONFIG.MOMENTUM_TRAILING_STOP_PERCENT / 100);
    } catch (error) {
      logger.error('[monitor] Failed to calculate momentum trailing stop:', error.message);
      return 0;
    }
  }
}
