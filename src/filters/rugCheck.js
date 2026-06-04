import fetch from 'node-fetch';
import CONFIG from '../../config.js';
import logger from '../logger.js';
import { retryWithBackoff } from '../utils/retry.js';

export async function isTokenSafe(mint) {
  if (CONFIG.SIMULATION_MODE) {
    return true;
  }

  try {
    if (!mint) return false;
    const report = await fetchRugCheckSummary(mint);
    return evaluateReport(report);
  } catch (error) {
    logger.error(`[rugcheck] Fail-closed for ${mint}:`, { error: error.message });
    return false;
  }
}

async function fetchRugCheckSummary(mint) {
  return retryWithBackoff(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.HTTP_TIMEOUT_MS);

    try {
      const response = await fetch(`https://api.rugcheck.xyz/v1/tokens/${encodeURIComponent(mint)}/report/summary`, {
        signal: controller.signal
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
      }

      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  });
}

function evaluateReport(report) {
  if (!report || typeof report !== 'object') return false;

  const score = Number(report.score);
  if (!Number.isFinite(score) || score < 500) return false;

  const risks = normalizeRisks(report.risks);
  if (risks.some((risk) => String(risk?.level || '').toLowerCase() === 'danger')) {
    return false;
  }

  if (!isMintAuthorityRevoked(report)) {
    return false;
  }

  const topTenHoldersPercent = getTopTenHoldersPercent(report);
  if (!Number.isFinite(topTenHoldersPercent) || topTenHoldersPercent > 30) {
    return false;
  }

  return true;
}

function normalizeRisks(risks) {
  if (Array.isArray(risks)) return risks;
  if (risks && typeof risks === 'object') return Object.values(risks);
  return [];
}

function isMintAuthorityRevoked(report) {
  const explicit = report.mintAuthorityRevoked
    ?? report.token?.mintAuthorityRevoked
    ?? report.mint?.mintAuthorityRevoked
    ?? report.authorities?.mintAuthorityRevoked;

  if (typeof explicit === 'boolean') return explicit;

  const authority = report.mintAuthority
    ?? report.token?.mintAuthority
    ?? report.mint?.mintAuthority
    ?? report.authorities?.mintAuthority;

  if (authority === null || authority === false) return true;
  if (typeof authority === 'string') {
    return ['', 'none', 'null', 'revoked', 'disabled'].includes(authority.trim().toLowerCase());
  }
  if (authority && typeof authority === 'object' && typeof authority.revoked === 'boolean') {
    return authority.revoked;
  }

  return false;
}

function getTopTenHoldersPercent(report) {
  const explicit = report.topTenHoldersPercent
    ?? report.top10HoldersPercent
    ?? report.topHoldersPercent
    ?? report.token?.topTenHoldersPercent
    ?? report.token?.top10HoldersPercent;

  if (explicit !== undefined) {
    return normalizePercent(Number(explicit));
  }

  const holders = report.topHolders
    ?? report.holders
    ?? report.token?.topHolders
    ?? report.token?.holders;

  if (!Array.isArray(holders) || holders.length < 10) {
    return Number.NaN;
  }

  return holders.slice(0, 10).reduce((total, holder) => {
    const value = Number(
      holder?.pct
      ?? holder?.percentage
      ?? holder?.percent
      ?? holder?.uiAmountPct
      ?? holder?.amountPct
      ?? 0
    );
    return total + normalizePercent(value);
  }, 0);
}

function normalizePercent(value) {
  if (!Number.isFinite(value)) return Number.NaN;
  if (value > 0 && value <= 1) return value * 100;
  return value;
}
