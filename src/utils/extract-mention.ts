// [AUDIT-M7, X12] Extract the user-facing payload from a group message
// that addresses our bot. We use Telegram's message.entities (typed
// offsets) rather than naive regex on text — this is the only correct
// way to handle case-insensitive usernames embedded in real Unicode
// content, e.g. "Привет @MyBot 😊".
//
// Rules:
//   - Mentions of @bot_username (any case) are stripped wherever they appear.
//   - A leading bot_command at offset 0 (e.g. "/about") is also stripped,
//     so the user's actual question survives. Commands that appear in the
//     MIDDLE of a message (e.g. quoted code) are intentionally left in
//     place — they're almost certainly content, not a command invocation.
//   - All edits are applied right-to-left so earlier offsets stay valid.

import type { Message, MessageEntity } from 'grammy/types';

export function extractTextWithoutMention(msg: Message, botUsername: string): string {
  const text = msg.text ?? '';
  if (!text) return '';
  const entities = msg.entities ?? [];
  const lowerUsername = botUsername.toLowerCase();

  // Sort entities by offset DESC so splicing doesn't shift remaining offsets.
  const sorted = [...entities].sort((a, b) => b.offset - a.offset);

  let result = text;
  for (const e of sorted) {
    const slice = result.slice(e.offset, e.offset + e.length);
    if (shouldStrip(e, slice, lowerUsername)) {
      result = result.slice(0, e.offset) + result.slice(e.offset + e.length);
    }
  }
  return result.trim();
}

function shouldStrip(entity: MessageEntity, slice: string, lowerUsername: string): boolean {
  if (entity.type === 'mention' && slice.toLowerCase() === `@${lowerUsername}`) {
    return true;
  }
  // Commands at the very start of the message are clearly the invocation,
  // not content. Anything later (e.g. /list inside a code sample) is left.
  if (entity.type === 'bot_command' && entity.offset === 0) {
    return true;
  }
  return false;
}
