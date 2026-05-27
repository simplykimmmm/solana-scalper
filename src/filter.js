import CONFIG from '../config.js';

export function filterCandidate(candidate, positions) {
  try {
    if (!candidate) {
      return { passed: false, reason: 'missing candidate' };
    }

    const liquidityUsd = Number(candidate.liquidity?.usd || 0);
    if (liquidityUsd <= CONFIG.MIN_LIQUIDITY_USD) {
      return { passed: false, reason: `liquidity ${liquidityUsd} below ${CONFIG.MIN_LIQUIDITY_USD}` };
    }

    const pairCreatedAt = Number(candidate.pairCreatedAt || 0);
    if (!pairCreatedAt) {
      return { passed: false, reason: 'missing pair creation timestamp' };
    }

    const ageMinutes = (Date.now() - pairCreatedAt) / 60000;
    if (ageMinutes > CONFIG.MAX_TOKEN_AGE_MINUTES) {
      return { passed: false, reason: `token age ${ageMinutes.toFixed(1)}m exceeds ${CONFIG.MAX_TOKEN_AGE_MINUTES}m` };
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
    console.error('[filter] Candidate filter failed:', error.message);
    return { passed: false, reason: `filter error: ${error.message}` };
  }
}
