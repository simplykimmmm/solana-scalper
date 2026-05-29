import CONFIG from '../config.js';

export const openPositions = new Set();

let dailyPnlSol = 0;
let dailyPnlDayKey = getUtcDayKey();

export function canOpenPosition() {
  resetDailyPnlIfNeeded();
  return openPositions.size < CONFIG.MAX_OPEN_POSITIONS;
}

export function openPosition(mint) {
  if (!mint) return;
  openPositions.add(String(mint));
}

export function closePosition(mint) {
  if (!mint) return;
  openPositions.delete(String(mint));
}

export function recordTrade(pnlSol) {
  resetDailyPnlIfNeeded();
  dailyPnlSol += Number(pnlSol || 0);
  return dailyPnlSol;
}

export function isDailyLimitBreached() {
  resetDailyPnlIfNeeded();
  return dailyPnlSol < -Math.abs(Number(CONFIG.MAX_DAILY_LOSS_SOL || 0));
}

export function getStateSnapshot() {
  resetDailyPnlIfNeeded();
  return {
    openPositions: [...openPositions],
    dailyPnlSol: Number(dailyPnlSol),
    dailyPnlDayKey,
    maxOpenPositions: Number(CONFIG.MAX_OPEN_POSITIONS),
    maxDailyLossSol: Number(CONFIG.MAX_DAILY_LOSS_SOL),
    dailyLimitBreached: isDailyLimitBreached()
  };
}

function resetDailyPnlIfNeeded() {
  const dayKey = getUtcDayKey();
  if (dayKey !== dailyPnlDayKey) {
    dailyPnlDayKey = dayKey;
    dailyPnlSol = 0;
  }
}

function getUtcDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}
