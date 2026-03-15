import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.logLevel,
  transport:
    config.nodeEnv === 'development'
      ? {
          target: 'pino/file',
          options: { destination: 1 }, // stdout
        }
      : undefined,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export function createChildLogger(name: string): pino.Logger {
  return logger.child({ module: name });
}
