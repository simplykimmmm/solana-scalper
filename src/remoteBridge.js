import CONFIG from '../config.js';
import logger from './logger.js';

export default class RemoteBridge {
  constructor({ getStatus, onCommand }) {
    this.getStatus = getStatus;
    this.onCommand = onCommand;
    this.agentId = CONFIG.REMOTE_BRIDGE_AGENT_ID;
    this.baseUrl = String(CONFIG.REMOTE_BRIDGE_URL || '').replace(/\/+$/, '');
    this.token = String(CONFIG.REMOTE_BRIDGE_TOKEN || '');
    this.pollMs = Math.max(1000, Number(CONFIG.REMOTE_BRIDGE_POLL_MS || 3000));
    this.timer = null;
    this.busy = false;
    this.lastCommandId = 0;
  }

  start() {
    try {
      if (!this.baseUrl || !this.token) {
        logger.info('[remote] Remote bridge disabled; set REMOTE_BRIDGE_URL and REMOTE_BRIDGE_TOKEN to enable it.');
        return;
      }

      if (this.timer) return;
      logger.info(`[remote] Remote bridge enabled for ${this.baseUrl} as ${this.agentId}.`);
      this.tick().catch((error) => {
        logger.error('[remote] Initial bridge tick failed:', { error: error.message });
      });
      this.timer = setInterval(() => {
        try {
          this.tick().catch((error) => {
            logger.error('[remote] Bridge tick failed:', { error: error.message });
          });
        } catch (error) {
          logger.error('[remote] Bridge tick scheduling failed:', { error: error.message });
        }
      }, this.pollMs);
    } catch (error) {
      logger.error('[remote] Failed to start remote bridge:', { error: error.message });
    }
  }

  stop() {
    try {
      if (!this.timer) return;
      clearInterval(this.timer);
      this.timer = null;
    } catch (error) {
      logger.error('[remote] Failed to stop remote bridge:', { error: error.message });
    }
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;

    try {
      const status = await this.getStatus();
      await this.post('/api/agent/status', {
        agentId: this.agentId,
        sentAt: Date.now(),
        status
      });

      const response = await this.post('/api/agent/poll', {
        agentId: this.agentId,
        lastCommandId: this.lastCommandId
      });

      const command = response?.command;
      if (command?.id && Number(command.id) > this.lastCommandId) {
        await this.handleCommand(command);
      }
    } catch (error) {
      logger.error('[remote] Bridge sync failed:', { error: error.message });
    } finally {
      this.busy = false;
    }
  }

  async handleCommand(command) {
    try {
      const action = String(command.action || '').toLowerCase();
      if (!['start', 'stop'].includes(action)) {
        logger.error('[remote] Ignoring unknown remote command.', { action });
        this.lastCommandId = Number(command.id);
        return;
      }

      await this.onCommand(command);
      this.lastCommandId = Number(command.id);
      logger.info(`[remote] Applied remote command ${action}#${command.id}.`);
    } catch (error) {
      logger.error('[remote] Failed to apply remote command:', { error: error.message });
    }
  }

  async post(pathname, payload) {
    const response = await fetch(`${this.baseUrl}${pathname}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch (error) {
        body = { raw: text };
      }
    }

    if (!response.ok) {
      throw new Error(body?.error || `HTTP ${response.status}`);
    }

    return body;
  }
}
