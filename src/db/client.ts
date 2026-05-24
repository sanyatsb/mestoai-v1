// Postgres client factory using postgres-js + Drizzle.
//
// Returns both the Drizzle handle (with schema + relations) and the raw
// postgres client (needed by drizzle-orm/postgres-js migrator and shutdown).

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { Logger } from '../types.js';
import * as relations from './relations.js';
import * as schema from './schema.js';

export type Database = ReturnType<typeof createDb>['db'];

export function createDb(opts: { url: string; logger: Logger }) {
  const sql = postgres(opts.url, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  const db = drizzle(sql, {
    schema: { ...schema, ...relations },
    logger: {
      logQuery(query, params) {
        opts.logger.trace({ query, params }, 'pg_query');
      },
    },
  });

  return {
    db,
    sql,
    /** Use during /ready endpoint and graceful shutdown. */
    async ping(): Promise<boolean> {
      try {
        await sql`SELECT 1`;
        return true;
      } catch (e) {
        opts.logger.error({ err: e }, 'db_ping_failed');
        return false;
      }
    },
    async close(): Promise<void> {
      await sql.end({ timeout: 5 });
    },
  };
}
