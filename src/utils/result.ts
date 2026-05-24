// Re-exports + small helpers for Result<T, E>.
// Keep the core `ok`/`err` in types.ts (used widely there); this file adds
// only ergonomic helpers.

export { ok, err } from '../types.js';
export type { Result, Ok, Err } from '../types.js';

import type { Err, Ok, Result } from '../types.js';

export function isOk<T, E>(r: Result<T, E>): r is Ok<T> {
  return r.ok;
}

export function isErr<T, E>(r: Result<T, E>): r is Err<E> {
  return !r.ok;
}

export function unwrap<T, E>(r: Result<T, E>): T {
  if (r.ok) return r.value;
  throw new Error(`unwrap on Err: ${JSON.stringify(r.error)}`);
}
