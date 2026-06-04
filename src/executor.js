import { PublicKey } from '@solana/web3.js';
import * as splToken from '@solana/spl-token';
import CONFIG from '../config.js';
import logger from './logger.js';
import { callRpc } from './rpcClient.js';
import {
  buildSwapTransaction,
  getComputeUnitPrice,
  getQuote,
  signSendAndConfirmSwap
} from './swap.js';
import { retryWithBackoff } from './utils/retry.js';

export default class Executor {
  constructor(connection, wallet) {
    try {
      this.connection = connection;
      this.wallet = wallet;
    } catch (error) {
      logger.error('[executor] Failed to initialize executor:', { error: error.message });
    }
  }

  async buy(candidate) {
    try {
      const amountLamports = String(Math.floor(CONFIG.TRADE_SIZE_SOL * 1e9));

      if (CONFIG.SIMULATION_MODE) {
        this.logTradeAction('BUY_SIM', candidate.symbol, candidate.priceUsd, '0.00%');
        return {
          success: true,
          txSignature: `SIM-BUY-${Date.now()}`,
          entryPrice: Number(candidate.priceUsd || 0),
          amountOut: '0'
        };
      }

      const quoteResponse = await getQuote(
        CONFIG.SOL_MINT,
        candidate.tokenAddress,
        amountLamports,
        Number(candidate?.liquidity?.usd || 0)
      );
      const computeUnitPrice = await getComputeUnitPrice();
      const swapResponse = await buildSwapTransaction(
        quoteResponse,
        this.wallet.publicKey.toBase58(),
        computeUnitPrice
      );
      const txSignature = await signSendAndConfirmSwap({
        wallet: this.wallet,
        swapResponse
      });

      this.logTradeAction('BUY', candidate.symbol, candidate.priceUsd, '0.00%');
      return {
        success: true,
        txSignature,
        entryPrice: Number(candidate.priceUsd || 0),
        amountOut: String(quoteResponse.outAmount || '0')
      };
    } catch (error) {
      logger.error(`[executor] Buy failed for ${candidate?.symbol || candidate?.tokenAddress || 'unknown'}:`, { error: error.message });
      return { success: false, txSignature: '', entryPrice: 0, amountOut: '0' };
    }
  }

  async sell(position, currentPrice, reason = 'exit') {
    try {
      const token = position?.symbol || position?.tokenAddress || 'UNKNOWN';
      let amount = String(position?.amountOut || '0');
      const pnlPercent = this.calculatePnlPercent(position?.entryPrice, currentPrice);

      if (CONFIG.SIMULATION_MODE) {
        this.logTradeAction(`SELL_SIM_${reason}`, token, currentPrice, `${pnlPercent.toFixed(2)}%`);
        return {
          success: true,
          txSignature: `SIM-SELL-${Date.now()}`
        };
      }

      const walletTokenAmount = await this.getWalletTokenAmount(position.tokenAddress);
      if (walletTokenAmount && walletTokenAmount !== '0') {
        amount = walletTokenAmount;
      }

      if (!amount || amount === '0') {
        logger.error(`[executor] Cannot sell ${token}; amountOut is missing.`);
        return { success: false, txSignature: '' };
      }

      const quoteResponse = await getQuote(
        position.tokenAddress,
        CONFIG.SOL_MINT,
        amount,
        Number(position?.liquidityUsd || 0)
      );
      const computeUnitPrice = await getComputeUnitPrice();
      const swapResponse = await buildSwapTransaction(
        quoteResponse,
        this.wallet.publicKey.toBase58(),
        computeUnitPrice
      );
      const txSignature = await signSendAndConfirmSwap({
        wallet: this.wallet,
        swapResponse
      });

      this.logTradeAction(`SELL_${reason}`, token, currentPrice, `${pnlPercent.toFixed(2)}%`);
      return { success: true, txSignature };
    } catch (error) {
      logger.error(`[executor] Sell failed for ${position?.symbol || position?.tokenAddress || 'unknown'}:`, { error: error.message });
      return { success: false, txSignature: '' };
    }
  }

  async getWalletTokenAmount(tokenMint) {
    try {
      const mint = new PublicKey(tokenMint);
      const tokenAccount = await this.getAssociatedTokenAddress(mint, this.wallet.publicKey);
      const balance = await retryWithBackoff(
        () => callRpc('getTokenAccountBalance', [
          tokenAccount.toBase58(),
          { commitment: 'confirmed' }
        ]),
        CONFIG.RPC_MAX_ATTEMPTS,
        CONFIG.RPC_BASE_DELAY_MS
      );
      return String(balance.value.amount || '0');
    } catch (error) {
      logger.error(`[executor] Failed to read token account balance for ${tokenMint}:`, { error: error.message });
      return '0';
    }
  }

  async getAssociatedTokenAddress(mint, owner) {
    try {
      if (typeof splToken.getAssociatedTokenAddress === 'function') {
        return await splToken.getAssociatedTokenAddress(mint, owner);
      }

      if (typeof splToken.getAssociatedTokenAddressSync === 'function') {
        return splToken.getAssociatedTokenAddressSync(mint, owner);
      }

      throw new Error('No compatible associated token address helper found in @solana/spl-token.');
    } catch (error) {
      logger.error('[executor] Failed to derive associated token address:', { error: error.message });
      throw error;
    }
  }

  calculatePnlPercent(entryPrice, currentPrice) {
    try {
      const entry = Number(entryPrice || 0);
      const current = Number(currentPrice || 0);
      if (!entry) return 0;
      return ((current - entry) / entry) * 100;
    } catch (error) {
      logger.error('[executor] Failed to calculate PnL:', { error: error.message });
      return 0;
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
      logger.error('[executor] Failed to log trade action:', { error: error.message });
    }
  }
}
