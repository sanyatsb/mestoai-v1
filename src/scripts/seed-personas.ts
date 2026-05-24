// [AUDIT-L18] Seed personas from data/personas.yaml.
//
// Behaviour:
//   - Read src/data/personas.yaml relative to this file's location (works for
//     both tsx in dev and node + dist in prod).
//   - Validate the parsed shape with zod (fail loudly on schema drift).
//   - Upsert each persona by slug (idempotent; safe to run on every boot).
//
// Used by Docker entrypoint (`CMD migrate && seed-personas && main`) so that
// a fresh container always has the latest persona list, and by `pnpm tsx
// src/scripts/seed-personas.ts` for local dev.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';
import { env } from '../config.js';
import { createDb } from '../db/client.js';
import { createPersonasRepository } from '../db/repositories/personas.js';
import { logger } from '../utils/logger.js';

const PersonaYamlSchema = z.object({
  slug: z.string().min(1),
  name_key: z.string().min(1),
  description_key: z.string().min(1),
  emoji: z.string().min(1),
  is_default: z.boolean().optional().default(false),
  is_active: z.boolean().optional().default(true),
  sort_order: z.number().int().nonnegative().optional().default(0),
  system_prompt: z.string().min(1),
});

const PersonasFileSchema = z.object({
  personas: z.array(PersonaYamlSchema).min(1),
});

async function main(): Promise<void> {
  // Locate personas.yaml next to compiled JS (dist/data/personas.yaml) or
  // next to the .ts in dev (src/data/personas.yaml). The Dockerfile copies
  // src/data → dist-adjacent so import.meta.url works in both.
  const yamlUrl = new URL('../data/personas.yaml', import.meta.url);
  const yamlPath = fileURLToPath(yamlUrl);
  logger.info({ yamlPath }, 'seed_personas_start');

  const raw = readFileSync(yamlPath, 'utf8');
  const parsed = PersonasFileSchema.parse(parse(raw));

  // [TZ §15 Week 3] Exactly one default persona is required so chat.ts can
  // always resolve user.activePersonaId ?? default.
  const defaults = parsed.personas.filter((p) => p.is_default);
  if (defaults.length !== 1) {
    throw new Error(`Expected exactly 1 default persona, got ${defaults.length}`);
  }

  const dbHandle = createDb({ url: env.DATABASE_URL, logger });
  const repo = createPersonasRepository(dbHandle.db);

  for (const p of parsed.personas) {
    const inserted = await repo.upsertBySlug({
      slug: p.slug,
      nameKey: p.name_key,
      descriptionKey: p.description_key,
      emoji: p.emoji,
      systemPrompt: p.system_prompt,
      isDefault: p.is_default,
      isActive: p.is_active,
      sortOrder: p.sort_order,
    });
    logger.info({ slug: inserted.slug, id: inserted.id }, 'persona_upserted');
  }

  await dbHandle.close();
  logger.info({ count: parsed.personas.length }, 'seed_personas_done');
}

main().catch((e) => {
  logger.fatal({ err: e }, 'seed_personas_failed');
  process.exit(1);
});
