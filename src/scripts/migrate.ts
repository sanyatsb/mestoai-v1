// [AUDIT-M5] Idempotent migration runner used by Docker entrypoint.
//   docker run ... node dist/scripts/migrate.js
//
// Locally you can also use `pnpm db:migrate` (drizzle-kit).

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { env } from '../config.js';
import { logger } from '../utils/logger.js';

async function main(): Promise<void> {
  logger.info('migration_start');
  const sql = postgres(env.DATABASE_URL, { max: 1 });
  const db = drizzle(sql);
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
  await sql.end({ timeout: 5 });
  logger.info('migration_complete');
}

main().catch((e) => {
  logger.fatal({ err: e }, 'migration_failed');
  process.exit(1);
});
