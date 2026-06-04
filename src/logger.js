import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pino from 'pino';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const logDir = path.join(rootDir, 'logs');

fs.mkdirSync(logDir, { recursive: true });

const pinoLogger = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
    base: null,
    timestamp: pino.stdTimeFunctions.isoTime
  },
  pino.multistream([
    { stream: process.stdout },
    { stream: pino.destination({ dest: path.join(logDir, 'bot.log'), sync: false }) }
  ])
);

const logger = {
  info: (msg, data) => pinoLogger.info(data ?? {}, String(msg)),
  error: (msg, data) => pinoLogger.error(data ?? {}, String(msg)),
  warn: (msg, data) => pinoLogger.warn(data ?? {}, String(msg)),
  debug: (msg, data) => pinoLogger.debug(data ?? {}, String(msg)),
  child: (...args) => pinoLogger.child(...args)
};

export default logger;
