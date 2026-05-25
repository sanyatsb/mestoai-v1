// DocumentService unit tests.
//
// We test:
//   - txt fixture round-trips through extractText (TextDecoder path)
//   - too_large rejects before any parser is invoked
//   - unsupported_format rejects on non-PDF/DOCX/TXT mimes
//   - empty/whitespace input → parse_failed
//
// PDF/DOCX parsers are integration-y (unpdf pulls PDF.js, mammoth pulls
// xmldom). We rely on the txt path here and let Week 4 manual QA cover
// PDF/DOCX on real fixtures.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createDocumentService } from '../../../src/services/document.js';
import type { Tokenizer } from '../../../src/types.js';

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

const tokenizer: Tokenizer = {
  estimate: (text) => Math.ceil(text.length / 4),
};

const svc = createDocumentService({ tokenizer, logger: silentLogger });

describe('DocumentService.extractText', () => {
  it('extracts text/plain via TextDecoder', async () => {
    const fixtureUrl = new URL('../../fixtures/sample.txt', import.meta.url);
    const bytes = new Uint8Array(readFileSync(fixtureUrl));
    const result = await svc.extractText({
      fileBytes: bytes,
      mimeType: 'text/plain',
      maxSizeMb: 1,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.text).toContain('test document');
      expect(result.value.pages).toBe(1);
      expect(result.value.tokensEstimate).toBeGreaterThan(0);
    }
  });

  it('extracts text/markdown the same as text/plain', async () => {
    const md = new TextEncoder().encode('# Heading\n\nSome **markdown** body.');
    const result = await svc.extractText({
      fileBytes: md,
      mimeType: 'text/markdown',
      maxSizeMb: 1,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.text).toContain('# Heading');
    }
  });

  it('rejects oversize uploads with too_large before parsing', async () => {
    // 2 MB of zeros — would happily parse as txt, but exceeds limit.
    const bytes = new Uint8Array(2 * 1024 * 1024);
    const result = await svc.extractText({
      fileBytes: bytes,
      mimeType: 'text/plain',
      maxSizeMb: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('too_large');
      if (result.error.kind === 'too_large') {
        expect(result.error.limit).toBe(1);
        expect(result.error.sizeMb).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('rejects unsupported mime types', async () => {
    const result = await svc.extractText({
      fileBytes: new Uint8Array([1, 2, 3]),
      mimeType: 'image/png',
      maxSizeMb: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('unsupported_format');
    }
  });

  it('returns parse_failed on an empty document', async () => {
    const result = await svc.extractText({
      fileBytes: new TextEncoder().encode('   \n\t '),
      mimeType: 'text/plain',
      maxSizeMb: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('parse_failed');
    }
  });
});
