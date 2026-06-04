import { readJson, rejectMethod, requireAuth, sendJson } from '../_http.js';
import { isPersistentStoreConfigured, setStatusSnapshot } from '../_store.js';

export default async function handler(req, res) {
  if (rejectMethod(req, res, ['POST'])) return;
  if (!requireAuth(req, res)) return;

  try {
    const body = await readJson(req);
    if (!body.status || typeof body.status !== 'object') {
      sendJson(res, 400, { error: 'status payload is required' });
      return;
    }

    await setStatusSnapshot({
      agentId: String(body.agentId || 'laptop-main'),
      sentAt: Number(body.sentAt || Date.now()),
      receivedAt: Date.now(),
      status: body.status
    });

    sendJson(res, 200, {
      success: true,
      persistentStore: isPersistentStoreConfigured()
    });
  } catch (error) {
    sendJson(res, 500, { success: false, error: error.message });
  }
}
