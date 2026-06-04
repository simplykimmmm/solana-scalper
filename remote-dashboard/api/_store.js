const STATUS_KEY = 'solana-scalper:remote:status';
const COMMAND_KEY = 'solana-scalper:remote:command';
const COMMAND_SEQ_KEY = 'solana-scalper:remote:command-seq';
const STATUS_TTL_SECONDS = 60;
const COMMAND_TTL_SECONDS = 86400;

export function isPersistentStoreConfigured() {
  return Boolean(getRedisConfig());
}

export async function setStatusSnapshot(snapshot) {
  await redisCommand([
    'SET',
    STATUS_KEY,
    JSON.stringify(snapshot),
    'EX',
    STATUS_TTL_SECONDS
  ]);
}

export async function getStatusSnapshot() {
  return parseJson(await redisCommand(['GET', STATUS_KEY]));
}

export async function createCommand(action) {
  const id = Number(await redisCommand(['INCR', COMMAND_SEQ_KEY]));
  const command = {
    id,
    action,
    requestedAt: Date.now()
  };

  await redisCommand([
    'SET',
    COMMAND_KEY,
    JSON.stringify(command),
    'EX',
    COMMAND_TTL_SECONDS
  ]);

  return command;
}

export async function getCommand() {
  return parseJson(await redisCommand(['GET', COMMAND_KEY]));
}

async function redisCommand(args) {
  const config = getRedisConfig();
  if (!config) return memoryCommand(args);

  const response = await fetch(config.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(args)
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) {
    throw new Error(body.error || `Redis REST HTTP ${response.status}`);
  }

  return body.result;
}

function getRedisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
  if (!url || !token) return null;
  return {
    url: String(url).replace(/\/+$/, ''),
    token
  };
}

function memoryCommand(args) {
  if (process.env.VERCEL && process.env.ALLOW_MEMORY_BRIDGE !== 'true') {
    throw new Error('Configure KV_REST_API_URL/KV_REST_API_TOKEN or UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN on Vercel.');
  }

  const store = getMemoryStore();
  const [command, key, value, ttlFlag, ttlSeconds] = args;
  const normalized = String(command || '').toUpperCase();

  if (normalized === 'GET') {
    const entry = store.values.get(key);
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      store.values.delete(key);
      return null;
    }
    return entry.value;
  }

  if (normalized === 'SET') {
    const ttlMs = String(ttlFlag || '').toUpperCase() === 'EX'
      ? Number(ttlSeconds || 0) * 1000
      : 0;
    store.values.set(key, {
      value,
      expiresAt: ttlMs ? Date.now() + ttlMs : 0
    });
    return 'OK';
  }

  if (normalized === 'INCR') {
    const current = Number(memoryCommand(['GET', key]) || 0) + 1;
    memoryCommand(['SET', key, String(current)]);
    return current;
  }

  throw new Error(`Unsupported memory Redis command: ${normalized}`);
}

function getMemoryStore() {
  if (!globalThis.__solanaScalperBridgeStore) {
    globalThis.__solanaScalperBridgeStore = {
      values: new Map()
    };
  }
  return globalThis.__solanaScalperBridgeStore;
}

function parseJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  return JSON.parse(String(value));
}
