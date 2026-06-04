import { readJson, rejectMethod, requireAuth, sendJson } from '../_http.js';
import { getCommand } from '../_store.js';

export default async function handler(req, res) {
  if (rejectMethod(req, res, ['POST'])) return;
  if (!requireAuth(req, res)) return;

  try {
    const body = await readJson(req);
    const lastCommandId = Number(body.lastCommandId || 0);
    const command = await getCommand();

    sendJson(res, 200, {
      command: command && Number(command.id) > lastCommandId ? command : null
    });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}
