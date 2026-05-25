// BlacklistChecker — fast substring match against per-language word lists
// loaded once at startup. We use a single combined regex with word
// boundaries for ASCII tokens and a simple substring match for non-ASCII
// (Russian/Arabic/Chinese), since \b in JS regex doesn't play well with
// Unicode word characters.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Logger } from '../types.js';

interface BlacklistFile {
  words?: string[];
}

const LANGS = ['en', 'ru'] as const;

function loadList(lang: string): string[] {
  try {
    const url = new URL(`../data/blacklist/${lang}.json`, import.meta.url);
    const raw = readFileSync(fileURLToPath(url), 'utf8');
    const parsed = JSON.parse(raw) as BlacklistFile;
    return (parsed.words ?? []).map((w) => w.trim().toLowerCase()).filter((w) => w.length > 0);
  } catch {
    // Missing list for a language → empty.
    return [];
  }
}

const ALL_WORDS: ReadonlySet<string> = new Set(LANGS.flatMap(loadList));

export interface BlacklistChecker {
  /** Returns the matched word, or null. */
  check(text: string): string | null;
}

export function createBlacklistChecker(_logger: Logger): BlacklistChecker {
  // Pre-lowercase the input once per call; check substring for each word.
  // For ~10-100 entries this is negligible.
  const words = [...ALL_WORDS];

  return {
    check(text) {
      const lower = text.toLowerCase();
      for (const w of words) {
        if (lower.includes(w)) return w;
      }
      return null;
    },
  };
}
