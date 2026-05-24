// [AUDIT-L10] /health (liveness) — returns 200 as long as the process is up.
// No external dependencies are probed here. Use /ready for that.

import type { Hono } from 'hono';

export function registerHealth(app: Hono): void {
  app.get('/health', (c) => c.json({ status: 'ok' }));
}
