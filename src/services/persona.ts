// PersonaService — exposes personas to composers and renders the system
// prompt for chat.ts.
//
// [AUDIT-L14] renderSystemPrompt appends an explicit
// "ALWAYS respond in: {userLang}" so Kimi doesn't slip into English when
// the persona prompt itself is written in English (which all 10 are).
//
// [AUDIT-A5] When a document is attached the document text is appended too —
// chat.ts pre-checks via tokenizer.estimate before calling the model so we
// can bail out with a clean error if it overflows the 256K window.

import type { PersonasRepository } from '../db/repositories/personas.js';
import type { Persona as PersonaRow } from '../db/schema.js';
import type { Logger, PersonaId } from '../types.js';
import { toPersonaId } from '../utils/ids.js';

// Concrete list of slugs the MVP ships with. Wider than data/personas.yaml is
// not allowed without a code change (so we can branch on persona in handlers
// confidently in later weeks).
export type PersonaSlug =
  | 'default'
  | 'analyst'
  | 'coder'
  | 'therapist'
  | 'translator'
  | 'editor'
  | 'researcher'
  | 'teacher'
  | 'chef'
  | 'writer';

export interface Persona {
  id: PersonaId;
  slug: PersonaSlug;
  nameKey: string;
  descriptionKey: string;
  emoji: string;
  systemPrompt: string;
  isDefault: boolean;
  isActive: boolean;
  sortOrder: number;
}

function toDomain(row: PersonaRow): Persona {
  return {
    id: toPersonaId(row.id),
    slug: row.slug as PersonaSlug,
    nameKey: row.nameKey,
    descriptionKey: row.descriptionKey,
    emoji: row.emoji,
    systemPrompt: row.systemPrompt,
    isDefault: row.isDefault,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
  };
}

export interface PersonaService {
  listActive(): Promise<Persona[]>;
  getBySlug(slug: PersonaSlug): Promise<Persona | null>;
  getById(id: PersonaId): Promise<Persona | null>;
  /**
   * Returns the persona marked is_default in the DB, or throws if none is
   * present. The seed script guarantees one exists after a successful boot.
   */
  getDefault(): Promise<Persona>;

  /**
   * Render the final system prompt: persona body + language pin + optional
   * attached document.
   */
  renderSystemPrompt(opts: {
    persona: Persona;
    userLang: string;
    documentText?: string;
    documentName?: string;
  }): string;
}

export interface PersonaServiceDeps {
  personas: PersonasRepository;
  logger: Logger;
}

export function createPersonaService(deps: PersonaServiceDeps): PersonaService {
  return {
    async listActive() {
      const rows = await deps.personas.listActive();
      return rows.map(toDomain);
    },

    async getBySlug(slug) {
      const row = await deps.personas.findBySlug(slug);
      return row ? toDomain(row) : null;
    },

    async getById(id) {
      const row = await deps.personas.findById(id as number);
      return row ? toDomain(row) : null;
    },

    async getDefault() {
      const row = await deps.personas.findDefault();
      if (!row) throw new Error('No default persona seeded — run seed-personas');
      return toDomain(row);
    },

    renderSystemPrompt(opts) {
      const lines: string[] = [opts.persona.systemPrompt.trim()];

      // [AUDIT-L14] Explicit language pin to keep replies in the user's
      // chosen UI language even when the persona prompt is in English.
      lines.push('', `ALWAYS respond in: ${opts.userLang}`);

      if (opts.documentText && opts.documentText.length > 0) {
        lines.push(
          '',
          `--- Attached document${opts.documentName ? ` (${opts.documentName})` : ''} ---`,
          opts.documentText,
        );
      }
      return lines.join('\n');
    },
  };
}
