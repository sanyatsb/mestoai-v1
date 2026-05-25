import { describe, expect, it } from 'vitest';
import { createBlacklistChecker } from '../../../src/services/blacklist-checker.js';

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

const check = createBlacklistChecker(silentLogger).check;

describe('BlacklistChecker', () => {
  it('matches words from the en list (case-insensitive)', () => {
    expect(check('this contains CSAM material')).toBeTruthy();
    expect(check('Child Porn')).toBeTruthy();
  });

  it('matches words from the ru list', () => {
    expect(check('содержит детское порно')).toBeTruthy();
  });

  it('returns null for benign text', () => {
    expect(check('hello world, how are you?')).toBeNull();
    expect(check('я просто хочу салат')).toBeNull();
  });
});
