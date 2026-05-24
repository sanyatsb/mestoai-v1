// personas repository — DB access only. PersonaService composes the
// rendered system prompt on top.

import { asc, eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import { type NewPersona, type Persona, personas } from '../schema.js';

export interface PersonasRepository {
  listActive(): Promise<Persona[]>;
  findBySlug(slug: string): Promise<Persona | undefined>;
  findById(id: number): Promise<Persona | undefined>;
  findDefault(): Promise<Persona | undefined>;
  /** Upsert by slug — used by the seed-personas script. */
  upsertBySlug(row: NewPersona): Promise<Persona>;
}

export function createPersonasRepository(db: Database): PersonasRepository {
  return {
    async listActive() {
      return db
        .select()
        .from(personas)
        .where(eq(personas.isActive, true))
        .orderBy(asc(personas.sortOrder));
    },

    async findBySlug(slug) {
      const rows = await db.select().from(personas).where(eq(personas.slug, slug)).limit(1);
      return rows[0];
    },

    async findById(id) {
      const rows = await db.select().from(personas).where(eq(personas.id, id)).limit(1);
      return rows[0];
    },

    async findDefault() {
      const rows = await db.select().from(personas).where(eq(personas.isDefault, true)).limit(1);
      return rows[0];
    },

    async upsertBySlug(row) {
      const [created] = await db
        .insert(personas)
        .values(row)
        .onConflictDoUpdate({
          target: personas.slug,
          set: {
            nameKey: row.nameKey,
            descriptionKey: row.descriptionKey,
            emoji: row.emoji,
            systemPrompt: row.systemPrompt,
            isDefault: row.isDefault ?? false,
            isActive: row.isActive ?? true,
            sortOrder: row.sortOrder ?? 0,
          },
        })
        .returning();
      if (!created) throw new Error('personas.upsertBySlug returned no row');
      return created;
    },
  };
}
