// Centralized common types: branded IDs, Result, DomainError, Tokenizer.
//
// [AUDIT-X3, X4] Tokenizer is declared here (not in services) so it can be injected
// via ctx.services without creating an import cycle.

import type { Logger as PinoLogger } from 'pino';

// ===== Branded ID types =====
// Prevents accidentally passing a UserId where ConversationId is expected.

export type UserId = number & { readonly __brand: 'UserId' };
export type ConversationId = number & { readonly __brand: 'ConversationId' };
export type MessageId = number & { readonly __brand: 'MessageId' };
export type PersonaId = number & { readonly __brand: 'PersonaId' };
export type TelegramUserId = number & { readonly __brand: 'TelegramUserId' };
export type TelegramMessageId = number & { readonly __brand: 'TelegramMessageId' };

// ===== Result pattern =====
// Use for expected/recoverable errors. Throw only for unexpected.

export type Ok<T> = { ok: true; value: T };
export type Err<E> = { ok: false; error: E };
export type Result<T, E = Error> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

// ===== Domain errors =====

export type DomainError =
  | { kind: 'rate_limit'; current: number; limit: number; resetsInSec: number }
  | { kind: 'banned'; reason: string; until: Date | null }
  | { kind: 'moderation_blocked'; categories: string[] }
  | { kind: 'kill_switch_active' }
  | { kind: 'service_unavailable'; service: string }
  | { kind: 'document_overflow'; reservedTokens: number }
  | { kind: 'validation'; field: string; message: string };

// ===== Tokenizer (estimate only) [AUDIT-X3, H3] =====
// Token counting for guards (e.g. "will doc fit"). NOT for cost — cost uses
// `usage` from gateway. Estimates may be off by up to ~30% on Kimi.

export interface Tokenizer {
  estimate(text: string): number;
}

// ===== Logger alias =====

export type Logger = PinoLogger;
