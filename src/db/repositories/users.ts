// users repository — thin DB layer. Business logic (deleteCascade,
// flag-count increments with ban thresholds, etc.) lives in services/users.ts
// and services/moderation.ts.

import { eq, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { type NewUser, type User, users } from '../schema.js';

export interface UsersRepository {
  findByTgId(tgId: number): Promise<User | undefined>;
  create(row: NewUser): Promise<User>;
  update(id: number, patch: Partial<User>): Promise<void>;
}

export function createUsersRepository(db: Database): UsersRepository {
  return {
    async findByTgId(tgId) {
      const rows = await db.select().from(users).where(eq(users.tgId, tgId)).limit(1);
      return rows[0];
    },
    async create(row) {
      const [created] = await db.insert(users).values(row).returning();
      if (!created) throw new Error('users.create returned no row');
      return created;
    },
    async update(id, patch) {
      await db
        .update(users)
        .set({ ...patch, updatedAt: sql`NOW()` })
        .where(eq(users.id, id));
    },
  };
}
