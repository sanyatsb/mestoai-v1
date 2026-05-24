// pino logger with traceId helper.
//
// [AUDIT-M3, B4] In Docker we always emit JSON. Pretty output is opt-in via
// `pnpm dev:pretty` (pipes through pino-pretty in a separate process). We do
// NOT use pino's transport API to avoid worker-thread fragility on Alpine.

import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { env } from '../config.js';
import type { Logger } from '../types.js';

export const logger: Logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'gonka-bot' },
});

/**
 * [AUDIT-L12, X9] Create a per-request child logger with a fresh traceId.
 * Inject the result into ctx in logging middleware so every log entry from
 * downstream handlers carries the same traceId.
 */
export function createRequestLogger(parent: Logger): { logger: Logger; traceId: string } {
  const traceId = randomUUID();
  return { logger: parent.child({ traceId }), traceId };
}
