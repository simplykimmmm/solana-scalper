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

function formatArg(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatArgs(args) {
  return args.map(formatArg).join(' ');
}

const logger = {
  info: (...args) => pinoLogger.info(formatArgs(args)),
  error: (...args) => {
    const error = args.find((arg) => arg instanceof Error);
    if (error) {
      pinoLogger.error({ err: error }, formatArgs(args.filter((arg) => arg !== error)));
      return;
    }
    pinoLogger.error(formatArgs(args));
  },
  warn: (...args) => pinoLogger.warn(formatArgs(args)),
  debug: (...args) => pinoLogger.debug(formatArgs(args)),
  child: (...args) => pinoLogger.child(...args)
};

export default logger;
