// UsersService — user lifecycle business logic.
//
// Week 2 surface: getOrCreate (used by auth middleware), update (used by
// /persona handler in Week 3+).
//
// Week 6 will add deleteCascade for /delete_my_data [AUDIT-A1, B3].

import type { UsersRepository } from '../db/repositories/users.js';
import type { NewUser, User } from '../db/schema.js';
import type { Logger } from '../types.js';

export interface UsersService {
  getOrCreate(opts: {
    tgId: number;
    tgUsername?: string;
    firstName?: string;
    languageCode?: string;
  }): Promise<User>;

  update(userId: number, patch: Partial<User>): Promise<void>;
}

export interface UsersServiceDeps {
  users: UsersRepository;
  logger: Logger;
}

export function createUsersService(deps: UsersServiceDeps): UsersService {
  return {
    async getOrCreate(opts) {
      const existing = await deps.users.findByTgId(opts.tgId);
      if (existing) return existing;

      const row: NewUser = {
        tgId: opts.tgId,
        tgUsername: opts.tgUsername ?? null,
        firstName: opts.firstName ?? null,
        languageCode: opts.languageCode ?? 'en',
      };
      const created = await deps.users.create(row);
      deps.logger.info({ tgId: opts.tgId, userId: created.id }, 'user_created');
      return created;
    },

    async update(userId, patch) {
      await deps.users.update(userId, patch);
    },
  };
}
