import fetch from 'node-fetch';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import * as splToken from '@solana/spl-token';
import CONFIG from '../config.js';

export default class Executor {
  constructor(connection, wallet) {
    try {
      this.connection = connection;
      this.wallet = wallet;
    } catch (error) {
      console.error('[executor] Failed to initialize executor:', error.message);
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

      const quoteResponse = await this.getQuote(CONFIG.SOL_MINT, candidate.tokenAddress, amountLamports);
      if (!quoteResponse) {
        return { success: false, txSignature: '', entryPrice: 0, amountOut: '0' };
      }

      const swapResponse = await this.getSwapTransaction(quoteResponse);
      if (!swapResponse?.swapTransaction) {
        console.error(`[executor] Swap transaction missing for buy ${candidate.symbol}`);
        return { success: false, txSignature: '', entryPrice: 0, amountOut: '0' };
      }

      const txSignature = await this.signSendAndConfirm(swapResponse);
      if (!txSignature) {
        return { success: false, txSignature: '', entryPrice: 0, amountOut: '0' };
      }

      this.logTradeAction('BUY', candidate.symbol, candidate.priceUsd, '0.00%');
      return {
        success: true,
        txSignature,
        entryPrice: Number(candidate.priceUsd || 0),
        amountOut: String(quoteResponse.outAmount || '0')
      };
    } catch (error) {
      console.error(`[executor] Buy failed for ${candidate?.symbol || candidate?.tokenAddress || 'unknown'}:`, error.message);
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
        console.error(`[executor] Cannot sell ${token}; amountOut is missing.`);
        return { success: false, txSignature: '' };
      }

      const quoteResponse = await this.getQuote(position.tokenAddress, CONFIG.SOL_MINT, amount);
      if (!quoteResponse) {
        return { success: false, txSignature: '' };
      }

      const swapResponse = await this.getSwapTransaction(quoteResponse);
      if (!swapResponse?.swapTransaction) {
        console.error(`[executor] Swap transaction missing for sell ${token}`);
        return { success: false, txSignature: '' };
      }

      const txSignature = await this.signSendAndConfirm(swapResponse);
      if (!txSignature) {
        return { success: false, txSignature: '' };
      }

      this.logTradeAction(`SELL_${reason}`, token, currentPrice, `${pnlPercent.toFixed(2)}%`);
      return { success: true, txSignature };
    } catch (error) {
      console.error(`[executor] Sell failed for ${position?.symbol || position?.tokenAddress || 'unknown'}:`, error.message);
      return { success: false, txSignature: '' };
    }
  }

  async getQuote(inputMint, outputMint, amount) {
    try {
      const url = new URL(CONFIG.JUPITER_QUOTE_URL);
      url.searchParams.set('inputMint', inputMint);
      url.searchParams.set('outputMint', outputMint);
      url.searchParams.set('amount', String(amount));
      url.searchParams.set('slippageBps', String(CONFIG.SLIPPAGE_BPS));
      url.searchParams.set('onlyDirectRoutes', 'false');

      const data = await this.fetchJson(url.toString());
      if (!data?.outAmount) {
        console.error(`[executor] Quote missing outAmount for ${inputMint} -> ${outputMint}`);
        return null;
      }
      return data;
    } catch (error) {
      console.error('[executor] Quote request failed:', error.message);
      return null;
    }
  }

  async getSwapTransaction(quoteResponse) {
    try {
      const data = await this.fetchJson(CONFIG.JUPITER_SWAP_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          quoteResponse,
          userPublicKey: this.wallet.publicKey.toBase58(),
          prioritizationFeeLamports: CONFIG.PRIORITY_FEE_LAMPORTS,
          dynamicComputeUnits: true
        })
      });
      return data;
    } catch (error) {
      console.error('[executor] Swap transaction request failed:', error.message);
      return null;
    }
  }

  async getWalletTokenAmount(tokenMint) {
    try {
      const mint = new PublicKey(tokenMint);
      const tokenAccount = await this.getAssociatedTokenAddress(mint, this.wallet.publicKey);
      const balance = await this.connection.getTokenAccountBalance(tokenAccount, 'confirmed');
      return String(balance.value.amount || '0');
    } catch (error) {
      console.error(`[executor] Failed to read token account balance for ${tokenMint}:`, error.message);
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

      const legacyToken = splToken.Token || splToken.default?.Token;
      const associatedProgramId = splToken.ASSOCIATED_TOKEN_PROGRAM_ID || splToken.default?.ASSOCIATED_TOKEN_PROGRAM_ID;
      const tokenProgramId = splToken.TOKEN_PROGRAM_ID || splToken.default?.TOKEN_PROGRAM_ID;

      if (legacyToken?.getAssociatedTokenAddress && associatedProgramId && tokenProgramId) {
        return await legacyToken.getAssociatedTokenAddress(
          associatedProgramId,
          tokenProgramId,
          mint,
          owner
        );
      }

      throw new Error('No compatible associated token address helper found in @solana/spl-token.');
    } catch (error) {
      console.error('[executor] Failed to derive associated token address:', error.message);
      throw error;
    }
  }

  async signSendAndConfirm(swapResponse) {
    try {
      const swapTransactionBuffer = Buffer.from(swapResponse.swapTransaction, 'base64');
      const transaction = VersionedTransaction.deserialize(swapTransactionBuffer);
      transaction.sign([this.wallet]);

      const txSignature = await this.connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: true,
        maxRetries: 3
      });

      const lastValidBlockHeight = Number(swapResponse.lastValidBlockHeight || 0);
      if (lastValidBlockHeight > 0) {
        const confirmation = await this.connection.confirmTransaction(
          {
            signature: txSignature,
            blockhash: transaction.message.recentBlockhash,
            lastValidBlockHeight
          },
          'confirmed'
        );

        if (confirmation.value.err) {
          console.error('[executor] Transaction confirmation error:', JSON.stringify(confirmation.value.err));
          return '';
        }
      } else {
        const confirmation = await this.connection.confirmTransaction(txSignature, 'confirmed');
        if (confirmation.value.err) {
          console.error('[executor] Transaction confirmation error:', JSON.stringify(confirmation.value.err));
          return '';
        }
      }

      return txSignature;
    } catch (error) {
      console.error('[executor] Failed to sign/send/confirm transaction:', error.message);
      return '';
    }
  }

  async fetchJson(url, options = {}) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        try {
          controller.abort();
        } catch (error) {
          console.error('[executor] Failed to abort timed-out request:', error.message);
        }
      }, CONFIG.HTTP_TIMEOUT_MS);

      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeout);

      if (!response.ok) {
        const text = await response.text();
        console.error(`[executor] HTTP ${response.status} for ${url}: ${text.slice(0, 200)}`);
        return null;
      }

      return await response.json();
    } catch (error) {
      console.error(`[executor] Failed to fetch JSON from ${url}:`, error.message);
      return null;
    }
  }

  calculatePnlPercent(entryPrice, currentPrice) {
    try {
      const entry = Number(entryPrice || 0);
      const current = Number(currentPrice || 0);
      if (!entry) return 0;
      return ((current - entry) / entry) * 100;
    } catch (error) {
      console.error('[executor] Failed to calculate PnL:', error.message);
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
      console.log(`[${timestamp}] ${action} ${token} ${Number(price || 0).toFixed(10)} ${pnl}`);
    } catch (error) {
      console.error('[executor] Failed to log trade action:', error.message);
    }
  }
}
