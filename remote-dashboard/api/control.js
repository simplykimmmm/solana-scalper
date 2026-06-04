import { readJson, rejectMethod, requireAuth, sendJson } from './_http.js';
import { createCommand } from './_store.js';

export default async function handler(req, res) {
  if (rejectMethod(req, res, ['POST'])) return;
  if (!requireAuth(req, res)) return;

  try {
    const body = await readJson(req);
    const action = String(body.action || '').toLowerCase();
    if (!['start', 'stop'].includes(action)) {
      sendJson(res, 400, { error: 'action must be start or stop' });
      return;
    }

    const command = await createCommand(action);
    sendJson(res, 200, { success: true, command });
  } catch (error) {
    sendJson(res, 500, { success: false, error: error.message });
  }
}
