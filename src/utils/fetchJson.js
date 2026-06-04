import fetch from 'node-fetch';
import CONFIG from '../../config.js';

export async function fetchJson(url, options = {}, timeoutMs = CONFIG.HTTP_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    if (!response.ok) {
      const text = await response.text();
      const error = new Error(`HTTP ${response.status} for ${safeUrlForLog(url)}: ${text.slice(0, 200)}`);
      error.status = response.status;
      error.retryAfter = Number(response.headers.get('retry-after') || 0);
      throw error;
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
