// Main welcome keyboard shown after /start. Buttons are wired in Week 7A
// when the full /start flow lands; today they trigger a routed callback
// that just kicks the user toward the matching command.

import { InlineKeyboard } from 'grammy';
import type { MyContext } from '../context.js';

export const MAIN_MENU_CALLBACK_PREFIX = 'main_menu:';

export function buildMainMenuKeyboard(ctx: MyContext): InlineKeyboard {
  return new InlineKeyboard()
    .text(ctx.t('main_menu.chat'), `${MAIN_MENU_CALLBACK_PREFIX}chat`)
    .text(ctx.t('main_menu.persona'), `${MAIN_MENU_CALLBACK_PREFIX}persona`)
    .row()
    .text(ctx.t('main_menu.document'), `${MAIN_MENU_CALLBACK_PREFIX}document`)
    .text(ctx.t('main_menu.about'), `${MAIN_MENU_CALLBACK_PREFIX}about`);
}
