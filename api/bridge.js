import agentPoll from '../remote-dashboard/api/agent/poll.js';
import agentStatus from '../remote-dashboard/api/agent/status.js';
import control from '../remote-dashboard/api/control.js';
import status from '../remote-dashboard/api/status.js';
import { sendJson } from '../remote-dashboard/api/_http.js';

const routes = {
  'agent-poll': agentPoll,
  'agent-status': agentStatus,
  control,
  status
};

export default async function handler(req, res) {
  try {
    const url = new URL(req.url || '/', 'https://solana-scalper.local');
    const route = String(url.searchParams.get('route') || '');
    const routeHandler = routes[route];

    if (!routeHandler) {
      sendJson(res, 404, { error: 'unknown bridge route' });
      return;
    }

    await routeHandler(req, res);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}
