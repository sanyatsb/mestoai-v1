// Inline keyboards for the ToS + age-gate flow used by /start.

import { InlineKeyboard } from 'grammy';
import type { MyContext } from '../context.js';

export const TOS_CALLBACK_PREFIX = 'tos:';
export const AGE_CALLBACK_PREFIX = 'age:';

/** First step: short ToS intro with [Accept] and [Read full text] buttons. */
export function buildTosIntroKeyboard(ctx: MyContext): InlineKeyboard {
  return new InlineKeyboard()
    .text(ctx.t('tos.accept'), `${TOS_CALLBACK_PREFIX}accept`)
    .row()
    .text(ctx.t('tos.read_full'), `${TOS_CALLBACK_PREFIX}read`);
}

/** After /tos.full: just an [Accept] button to commit. */
export function buildTosAcceptKeyboard(ctx: MyContext): InlineKeyboard {
  return new InlineKeyboard().text(ctx.t('tos.accept'), `${TOS_CALLBACK_PREFIX}accept`);
}

/** Age-gate: yes / no. */
export function buildAgeKeyboard(ctx: MyContext): InlineKeyboard {
  return new InlineKeyboard()
    .text(ctx.t('age.yes'), `${AGE_CALLBACK_PREFIX}yes`)
    .text(ctx.t('age.no'), `${AGE_CALLBACK_PREFIX}no`);
}
