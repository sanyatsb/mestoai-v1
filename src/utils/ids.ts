// Branded ID factories. Use these to convert raw numbers into branded
// types at trust boundaries (DB reads, Telegram API responses).

import type {
  ConversationId,
  MessageId,
  PersonaId,
  TelegramMessageId,
  TelegramUserId,
  UserId,
} from '../types.js';

export const toUserId = (n: number): UserId => n as UserId;
export const toConversationId = (n: number): ConversationId => n as ConversationId;
export const toMessageId = (n: number): MessageId => n as MessageId;
export const toPersonaId = (n: number): PersonaId => n as PersonaId;
export const toTelegramUserId = (n: number): TelegramUserId => n as TelegramUserId;
export const toTelegramMessageId = (n: number): TelegramMessageId => n as TelegramMessageId;
