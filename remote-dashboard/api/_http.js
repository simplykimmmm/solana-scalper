import { timingSafeEqual } from 'crypto';

export function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

export function rejectMethod(req, res, allowed) {
  if (allowed.includes(req.method)) return false;
  res.setHeader('Allow', allowed.join(', '));
  sendJson(res, 405, { error: 'method not allowed' });
  return true;
}

export function requireAuth(req, res) {
  const expected = process.env.REMOTE_BRIDGE_TOKEN || process.env.BRIDGE_TOKEN || '';
  if (!expected) {
    sendJson(res, 500, { error: 'REMOTE_BRIDGE_TOKEN is not configured on the hosted dashboard.' });
    return false;
  }

  const provided = readBearerToken(req) || readHeader(req, 'x-bridge-token') || '';
  if (!safeEqual(provided, expected)) {
    sendJson(res, 401, { error: 'unauthorized' });
    return false;
  }

  return true;
}

export async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.trim()) return JSON.parse(req.body);

  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
  }

  return raw.trim() ? JSON.parse(raw) : {};
}

function readBearerToken(req) {
  const authorization = readHeader(req, 'authorization');
  if (!authorization) return '';
  const match = String(authorization).match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : '';
}

function readHeader(req, name) {
  const value = req.headers?.[name.toLowerCase()] || req.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
