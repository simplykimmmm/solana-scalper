import CONFIG from '../config.js';
import logger from './logger.js';

export function filterCandidate(candidate, positions) {
  try {
    if (!candidate) {
      return { passed: false, reason: 'missing candidate' };
    }

    const liquidityUsd = Number(candidate.liquidity?.usd || 0);
    if (liquidityUsd <= CONFIG.MIN_LIQUIDITY_USD) {
      return { passed: false, reason: `liquidity ${liquidityUsd} below ${CONFIG.MIN_LIQUIDITY_USD}` };
    }

    const priceChange5m = Number(candidate.priceChange5m || 0);
    const volumeH1 = Number(candidate.volumeH1 || 0);
    if (priceChange5m > 50 && volumeH1 < CONFIG.MIN_LIQUIDITY_USD * 0.5) {
      return { passed: false, reason: 'honeypot heuristic: sharp 5m pump with low volume' };
    }

    if (positions?.has(candidate.tokenAddress)) {
      return { passed: false, reason: 'already in position' };
    }

    return { passed: true, reason: 'passed filters' };
  } catch (error) {
    logger.error('[filter] Candidate filter failed:', { error: error.message });
    return { passed: false, reason: `filter error: ${error.message}` };
  }
}
