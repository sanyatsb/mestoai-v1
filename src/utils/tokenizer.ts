// [AUDIT-X3, H3, Q4] js-tiktoken wrapper.
//
// IMPORTANT: This is an *estimate* only. Kimi K2.6 uses a different tokenizer
// (closer to Qwen) so OpenAI's BPE can be off by up to ~30%. Use this for
// guards ("will the document fit in the context window") but never for cost
// tracking — for cost, always use `usage` from the gateway response.

import { encodingForModel } from 'js-tiktoken';
import type { Tokenizer } from '../types.js';

let cached: ReturnType<typeof encodingForModel> | null = null;

function getEncoder() {
  if (!cached) {
    // gpt-4o uses o200k_base, the most modern available encoding. Closest
    // ballpark for modern multilingual models.
    cached = encodingForModel('gpt-4o');
  }
  return cached;
}

export function createTokenizer(): Tokenizer {
  return {
    estimate(text: string): number {
      try {
        return getEncoder().encode(text).length;
      } catch {
        // Fallback: ~4 chars/token approximation.
        return Math.ceil(text.length / 4);
      }
    },
  };
}
