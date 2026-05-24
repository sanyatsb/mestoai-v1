import { describe, expect, it } from 'vitest';
import { splitForTelegram } from '../../../src/utils/telegram-split.js';

describe('splitForTelegram', () => {
  it('returns input as-is when under limit', () => {
    expect(splitForTelegram('hello', 100)).toEqual(['hello']);
  });

  it('splits on paragraph boundary when available', () => {
    const text = `${'a'.repeat(50)}\n\n${'b'.repeat(50)}`;
    const parts = splitForTelegram(text, 60);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe('a'.repeat(50));
    expect(parts[1]).toBe('b'.repeat(50));
  });

  it('splits on word boundary when no paragraph break', () => {
    const text = `${'word '.repeat(40)}stop`;
    const parts = splitForTelegram(text, 50);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(50);
    }
  });

  it('hard-cuts when no break point found in upper half', () => {
    const text = 'x'.repeat(200);
    const parts = splitForTelegram(text, 50);
    expect(parts).toHaveLength(4);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(50);
    }
  });

  it('concatenates back to original (allowing whitespace trim)', () => {
    const text = `${'first paragraph here. '.repeat(20)}\n\n${'second paragraph here. '.repeat(20)}`;
    const parts = splitForTelegram(text, 200);
    const recombined = parts.join(' ').replace(/\s+/g, ' ').trim();
    const expected = text.replace(/\s+/g, ' ').trim();
    expect(recombined).toBe(expected);
  });
});
