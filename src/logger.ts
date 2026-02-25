/**
 * @fileoverview Structured logger for the Cognigy A2A Gateway.
 *
 * Uses pino for structured JSON logging compatible with AWS CloudWatch.
 * In development (LOG_PRETTY=true) uses pino-pretty for human-readable output.
 *
 * Log levels: trace | debug | info | warn | error
 * Controlled via LOG_LEVEL environment variable (default: info).
 */

import pino from 'pino';

const isDev = process.env['LOG_PRETTY'] === 'true';
const level = process.env['LOG_LEVEL'] ?? 'info';

const transport = isDev
  ? pino.transport({ target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } })
  : undefined;

/**
 * Root application logger.
 * All child loggers should be created via logger.child({ component: '...' }).
 */
const logger = pino(
  {
    level,
    base: {
      service: 'cognigy-a2a-gateway',
      env: process.env['NODE_ENV'] ?? 'development',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  },
  transport,
);

export default logger;
export { logger };
