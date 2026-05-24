import { describe, expect, it, vi } from 'vitest';
import type { PersonasRepository } from '../../../src/db/repositories/personas.js';
import type { Persona as PersonaRow } from '../../../src/db/schema.js';
import {
  type Persona,
  type PersonaSlug,
  createPersonaService,
} from '../../../src/services/persona.js';
import { toPersonaId } from '../../../src/utils/ids.js';

const silentLogger = {
  child: () => silentLogger,
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  // biome-ignore lint/suspicious/noExplicitAny: minimal pino-like stub
} as any;

function makeRow(slug: PersonaSlug, isDefault = false): PersonaRow {
  return {
    id: slug === 'default' ? 1 : 2,
    slug,
    nameKey: `persona.${slug}.name`,
    descriptionKey: `persona.${slug}.desc`,
    emoji: '💬',
    systemPrompt: `You are the ${slug} persona.`,
    isDefault,
    isActive: true,
    sortOrder: 1,
    createdAt: new Date('2026-05-25T00:00:00Z'),
  };
}

function makeService(rows: PersonaRow[]) {
  const repo: PersonasRepository = {
    listActive: async () => rows.filter((r) => r.isActive),
    findBySlug: async (slug) => rows.find((r) => r.slug === slug),
    findById: async (id) => rows.find((r) => r.id === id),
    findDefault: async () => rows.find((r) => r.isDefault),
    upsertBySlug: vi.fn(),
  };
  return createPersonaService({ personas: repo, logger: silentLogger });
}

describe('PersonaService', () => {
  it('listActive returns only active personas', async () => {
    const svc = makeService([makeRow('default', true), makeRow('analyst')]);
    const all = await svc.listActive();
    expect(all).toHaveLength(2);
    expect(all.map((p) => p.slug)).toEqual(['default', 'analyst']);
  });

  it('getDefault throws when no default is seeded', async () => {
    const svc = makeService([makeRow('analyst')]);
    await expect(svc.getDefault()).rejects.toThrow(/No default persona/);
  });

  it('getById returns null on miss without throwing', async () => {
    const svc = makeService([makeRow('default', true)]);
    const result = await svc.getById(toPersonaId(999));
    expect(result).toBeNull();
  });

  describe('renderSystemPrompt', () => {
    const persona: Persona = {
      id: toPersonaId(1),
      slug: 'analyst',
      nameKey: 'persona.analyst.name',
      descriptionKey: 'persona.analyst.desc',
      emoji: '📊',
      systemPrompt: 'You are a data analyst. Be precise.',
      isDefault: false,
      isActive: true,
      sortOrder: 2,
    };

    it('appends ALWAYS respond in language pin [AUDIT-L14]', () => {
      const svc = makeService([]);
      const rendered = svc.renderSystemPrompt({ persona, userLang: 'ru' });
      expect(rendered).toContain('You are a data analyst');
      expect(rendered).toContain('ALWAYS respond in: ru');
    });

    it('appends attached document text and name when provided', () => {
      const svc = makeService([]);
      const rendered = svc.renderSystemPrompt({
        persona,
        userLang: 'en',
        documentText: 'this is the doc body',
        documentName: 'report.pdf',
      });
      expect(rendered).toContain('--- Attached document (report.pdf) ---');
      expect(rendered).toContain('this is the doc body');
      // Language pin still present
      expect(rendered).toContain('ALWAYS respond in: en');
    });

    it('omits document section when no document attached', () => {
      const svc = makeService([]);
      const rendered = svc.renderSystemPrompt({ persona, userLang: 'en' });
      expect(rendered).not.toContain('--- Attached document');
    });
  });
});
