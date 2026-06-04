import fetch from 'node-fetch';
import fs from 'fs/promises';
import CONFIG from '../config.js';
import logger from './logger.js';

const SYSTEM_PROMPT = 'You are a permissive Solana micro-scalp evaluator for small trade sizes. Score this token opportunity from 1-10. Liquidity must be at least $5k. Favor early momentum, active volume, and tradable volatility. Assume a quick 30-second scalp by default, but allow a 30-minute momentum ride only when the token shows strong 5-minute pump behavior with enough volume. Respond with ONLY compact JSON: {"score":number,"reason":"short reason under 12 words"}.';
const BUDGET_FILE_URL = new URL('../data/gemini-usage.json', import.meta.url);
const geminiBudget = {
  requestsThisRun: 0,
  lastRequestAt: 0,
  loaded: false,
  dayKey: '',
  tokensUsedToday: 0
};

export async function scoreCandidate(candidate) {
  try {
    if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'your_gemini_key_here') {
      logger.error('[scorer] GEMINI_API_KEY is missing; returning score 0.');
      return unavailableScore('missing GEMINI_API_KEY');
    }

    const prompt = buildPrompt(candidate);
    const budgetResult = await checkGeminiBudget(prompt);
    if (!budgetResult.allowed) {
      logger.error(`[scorer] Gemini budget guard: ${budgetResult.reason}`);
      return unavailableScore(budgetResult.reason);
    }

    const response = await callGemini(prompt, budgetResult.estimatedTokens);
    if (!response.ok) {
      return unavailableScore(response.reason);
    }

    return parseGeminiScore(response.data);
  } catch (error) {
    logger.error(`[scorer] Scoring failed for ${candidate?.symbol || candidate?.tokenAddress || 'unknown'}:`, { error: error.message });
    return unavailableScore(`scoring failed: ${error.message}`);
  }
}

async function callGemini(prompt, estimatedTokens) {
  try {
    geminiBudget.requestsThisRun += 1;
    geminiBudget.lastRequestAt = Date.now();
    await addGeminiTokenUsage(estimatedTokens, 'estimate before Gemini request');

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      try {
        controller.abort();
      } catch (error) {
        logger.error('[scorer] Failed to abort timed-out Gemini request:', { error: error.message });
      }
    }, CONFIG.HTTP_TIMEOUT_MS);

    const url = `${CONFIG.GEMINI_URL}?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: SYSTEM_PROMPT }]
        },
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }]
          }
        ],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json',
          maxOutputTokens: CONFIG.GEMINI_MAX_OUTPUT_TOKENS
        }
      })
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const body = await response.text();
      const reason = buildGeminiHttpReason(response.status, body, response.headers.get('retry-after'));
      logger.error(`[scorer] Gemini HTTP ${response.status}: ${reason}`);
      await reconcileGeminiTokenUsage(estimatedTokens, 0);
      return { ok: false, reason };
    }

    const data = await response.json();
    await reconcileGeminiTokenUsage(estimatedTokens, extractGeminiUsageTokens(data));
    return { ok: true, data };
  } catch (error) {
    logger.error('[scorer] Gemini request failed:', { error: error.message });
    await reconcileGeminiTokenUsage(estimatedTokens, 0);
    return { ok: false, reason: `Gemini request failed: ${error.name === 'AbortError' ? 'timeout' : error.message}` };
  }
}

async function checkGeminiBudget(prompt) {
  try {
    if (!CONFIG.GEMINI_BUDGET_MODE) {
      return { allowed: true, reason: 'budget mode disabled', estimatedTokens: 0 };
    }

    await loadGeminiBudget();

    if (geminiBudget.requestsThisRun >= CONFIG.GEMINI_MAX_REQUESTS_PER_RUN) {
      return {
        allowed: false,
        reason: `Gemini request cap reached (${geminiBudget.requestsThisRun}/${CONFIG.GEMINI_MAX_REQUESTS_PER_RUN} this run)`,
        estimatedTokens: 0
      };
    }

    const elapsedMs = Date.now() - geminiBudget.lastRequestAt;
    if (geminiBudget.lastRequestAt > 0 && elapsedMs < CONFIG.GEMINI_MIN_REQUEST_INTERVAL_MS) {
      const waitSeconds = Math.ceil((CONFIG.GEMINI_MIN_REQUEST_INTERVAL_MS - elapsedMs) / 1000);
      return {
        allowed: false,
        reason: `Gemini cooldown active (${waitSeconds}s remaining)`,
        estimatedTokens: 0
      };
    }

    const estimatedTokens = estimateGeminiRequestTokens(prompt);
    const usableTokens = getGeminiUsableDailyTokens();
    const remainingTokens = usableTokens - geminiBudget.tokensUsedToday;

    if (estimatedTokens > remainingTokens) {
      return {
        allowed: false,
        reason: `Gemini daily token budget would be exceeded (${geminiBudget.tokensUsedToday}/${usableTokens} used, estimate ${estimatedTokens})`,
        estimatedTokens
      };
    }

    return { allowed: true, reason: 'within Gemini request budget', estimatedTokens };
  } catch (error) {
    logger.error('[scorer] Failed to check Gemini budget:', { error: error.message });
    return { allowed: false, reason: `Gemini budget check failed: ${error.message}`, estimatedTokens: 0 };
  }
}

export async function getGeminiBudgetStatus() {
  try {
    await loadGeminiBudget();
    const usableTokens = getGeminiUsableDailyTokens();
    return {
      enabled: Boolean(CONFIG.GEMINI_BUDGET_MODE),
      dayKey: String(geminiBudget.dayKey),
      dailyTokenLimit: Number(CONFIG.GEMINI_DAILY_TOKEN_LIMIT),
      reserveTokens: Number(CONFIG.GEMINI_DAILY_TOKEN_RESERVE),
      usableTokens: Number(usableTokens),
      tokensUsedToday: Number(geminiBudget.tokensUsedToday),
      tokensRemainingToday: Number(Math.max(0, usableTokens - geminiBudget.tokensUsedToday)),
      requestsThisRun: Number(geminiBudget.requestsThisRun),
      maxRequestsPerRun: Number(CONFIG.GEMINI_MAX_REQUESTS_PER_RUN),
      minRequestIntervalMs: Number(CONFIG.GEMINI_MIN_REQUEST_INTERVAL_MS),
      maxOutputTokens: Number(CONFIG.GEMINI_MAX_OUTPUT_TOKENS)
    };
  } catch (error) {
    logger.error('[scorer] Failed to build Gemini budget status:', { error: error.message });
    return {
      enabled: Boolean(CONFIG.GEMINI_BUDGET_MODE),
      dayKey: '',
      dailyTokenLimit: Number(CONFIG.GEMINI_DAILY_TOKEN_LIMIT),
      reserveTokens: Number(CONFIG.GEMINI_DAILY_TOKEN_RESERVE),
      usableTokens: getGeminiUsableDailyTokens(),
      tokensUsedToday: 0,
      tokensRemainingToday: 0,
      requestsThisRun: Number(geminiBudget.requestsThisRun),
      maxRequestsPerRun: Number(CONFIG.GEMINI_MAX_REQUESTS_PER_RUN),
      minRequestIntervalMs: Number(CONFIG.GEMINI_MIN_REQUEST_INTERVAL_MS),
      maxOutputTokens: Number(CONFIG.GEMINI_MAX_OUTPUT_TOKENS)
    };
  }
}

async function loadGeminiBudget() {
  try {
    const dayKey = getBudgetDayKey();
    if (geminiBudget.loaded && geminiBudget.dayKey === dayKey) {
      return;
    }

    await fs.mkdir(new URL('../data/', import.meta.url), { recursive: true });

    let persisted = {};
    try {
      persisted = JSON.parse(await fs.readFile(BUDGET_FILE_URL, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.error('[scorer] Failed to read Gemini budget file:', { error: error.message });
      }
    }

    geminiBudget.dayKey = dayKey;
    geminiBudget.tokensUsedToday = persisted.dayKey === dayKey ? Number(persisted.tokensUsedToday || 0) : 0;
    geminiBudget.loaded = true;
    await saveGeminiBudget();
  } catch (error) {
    logger.error('[scorer] Failed to load Gemini budget:', { error: error.message });
  }
}

async function saveGeminiBudget() {
  try {
    await fs.mkdir(new URL('../data/', import.meta.url), { recursive: true });
    await fs.writeFile(BUDGET_FILE_URL, JSON.stringify({
      dayKey: geminiBudget.dayKey || getBudgetDayKey(),
      tokensUsedToday: Number(geminiBudget.tokensUsedToday || 0),
      updatedAt: new Date().toISOString()
    }, null, 2));
  } catch (error) {
    logger.error('[scorer] Failed to save Gemini budget:', { error: error.message });
  }
}

async function addGeminiTokenUsage(tokens, reason) {
  try {
    await loadGeminiBudget();
    const amount = Math.max(0, Number(tokens || 0));
    geminiBudget.tokensUsedToday += amount;
    await saveGeminiBudget();
    logger.info(`[scorer] Gemini token budget +${amount} (${reason}); used ${geminiBudget.tokensUsedToday}/${getGeminiUsableDailyTokens()} today.`);
  } catch (error) {
    logger.error('[scorer] Failed to add Gemini token usage:', { error: error.message });
  }
}

async function reconcileGeminiTokenUsage(estimatedTokens, actualTokens) {
  try {
    const actual = Math.max(0, Number(actualTokens || 0));

    await loadGeminiBudget();
    const estimate = Math.max(0, Number(estimatedTokens || 0));
    const delta = actual - estimate;
    geminiBudget.tokensUsedToday = Math.max(0, geminiBudget.tokensUsedToday + delta);
    await saveGeminiBudget();
    logger.info(`[scorer] Gemini actual token usage ${actual}; adjusted ${delta >= 0 ? '+' : ''}${delta}.`);
  } catch (error) {
    logger.error('[scorer] Failed to reconcile Gemini token usage:', { error: error.message });
  }
}

function extractGeminiUsageTokens(data) {
  try {
    return Number(data?.usageMetadata?.totalTokenCount || 0);
  } catch (error) {
    logger.error('[scorer] Failed to extract Gemini usage tokens:', { error: error.message });
    return 0;
  }
}

function estimateGeminiRequestTokens(prompt) {
  try {
    const inputText = `${SYSTEM_PROMPT}\n${prompt || ''}`;
    const conservativeInputTokens = Math.ceil(inputText.length / 3);
    return conservativeInputTokens + Number(CONFIG.GEMINI_MAX_OUTPUT_TOKENS || 120);
  } catch (error) {
    logger.error('[scorer] Failed to estimate Gemini request tokens:', { error: error.message });
    return Number(CONFIG.GEMINI_MAX_OUTPUT_TOKENS || 120) + 200;
  }
}

function getGeminiUsableDailyTokens() {
  try {
    return Math.max(0, Number(CONFIG.GEMINI_DAILY_TOKEN_LIMIT) - Number(CONFIG.GEMINI_DAILY_TOKEN_RESERVE));
  } catch (error) {
    logger.error('[scorer] Failed to calculate usable Gemini tokens:', { error: error.message });
    return 0;
  }
}

function getBudgetDayKey() {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: CONFIG.GEMINI_BUDGET_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    return formatter.format(new Date());
  } catch (error) {
    logger.error('[scorer] Failed to build budget day key:', { error: error.message });
    return new Date().toISOString().slice(0, 10);
  }
}

function buildPrompt(candidate) {
  try {
    return JSON.stringify({
      tokenAddress: candidate.tokenAddress,
      symbol: candidate.symbol,
      priceUsd: Number(candidate.priceUsd || 0),
      liquidity: Number(candidate.liquidity?.usd || 0),
      volumeH1: Number(candidate.volumeH1 || 0),
      priceChange1m: Number(candidate.priceChange1m || 0),
      priceChange5m: Number(candidate.priceChange5m || 0)
    });
  } catch (error) {
    logger.error('[scorer] Failed to build Gemini prompt:', { error: error.message });
    return '{}';
  }
}

function parseGeminiScore(data) {
  try {
    const text = extractGeminiText(data);
    if (!text) {
      const reason = describeEmptyGeminiResponse(data);
      logger.error('[scorer] Gemini returned no text:', {
        reason,
        finishReason: data?.candidates?.[0]?.finishReason || '',
        promptBlockReason: data?.promptFeedback?.blockReason || ''
      });
      return unavailableScore(reason);
    }

    const cleaned = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      score: Math.max(0, Math.min(10, Number(parsed.score || 0))),
      reason: String(parsed.reason || 'no reason returned'),
      cacheable: true
    };
  } catch (error) {
    logger.error('[scorer] Failed to parse Gemini response:', { error: error.message });
    return unavailableScore(`parse failed: ${error.message}`);
  }
}

function extractGeminiText(data) {
  try {
    const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
    return candidates
      .flatMap((candidate) => Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [])
      .map((part) => part?.text || '')
      .filter(Boolean)
      .join('')
      .trim();
  } catch (error) {
    logger.error('[scorer] Failed to extract Gemini text:', { error: error.message });
    return '';
  }
}

function describeEmptyGeminiResponse(data) {
  try {
    const blockReason = data?.promptFeedback?.blockReason;
    if (blockReason) return `Gemini prompt blocked: ${blockReason}`;

    const finishReason = data?.candidates?.[0]?.finishReason;
    if (finishReason) return `Gemini returned no text (finishReason=${finishReason})`;

    return 'Gemini returned no text';
  } catch (error) {
    logger.error('[scorer] Failed to describe empty Gemini response:', { error: error.message });
    return 'Gemini returned no text';
  }
}

function buildGeminiHttpReason(status, body, retryAfterHeader) {
  try {
    const parsed = JSON.parse(String(body || '{}'));
    const message = String(parsed?.error?.message || '').replace(/\s+/g, ' ').trim();
    const statusText = String(parsed?.error?.status || `HTTP ${status}`);
    const retryAfter = Number(retryAfterHeader || 0);

    if (status === 429) {
      const modelMatch = message.match(/limit:\s*0,\s*model:\s*([^*\n ]+)/i);
      const retryMatch = message.match(/retry in\s*([0-9.]+s)/i);
      const retryNote = retryAfter > 0
        ? ` retry after ${retryAfter}s`
        : retryMatch
          ? ` retry after ${retryMatch[1]}`
          : '';
      if (modelMatch) {
        return `Gemini quota exhausted for ${modelMatch[1]}; switch model or enable billing.${retryNote}`.trim();
      }
      return `Gemini quota/rate limit (${statusText}).${retryNote}`.trim();
    }

    if (message) {
      return `Gemini ${statusText}: ${message.slice(0, 240)}`;
    }

    return `Gemini HTTP ${status}`;
  } catch (error) {
    logger.error('[scorer] Failed to parse Gemini HTTP error:', { error: error.message });
    return `Gemini HTTP ${status}`;
  }
}

function unavailableScore(reason) {
  return {
    score: 0,
    reason: String(reason || 'Gemini unavailable'),
    cacheable: false
  };
}
