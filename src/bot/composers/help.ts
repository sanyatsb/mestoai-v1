// /help composer.

import { Composer } from 'grammy';
import type { MyContext } from '../context.js';

export const helpComposer = new Composer<MyContext>();

helpComposer.command('help', async (ctx) => {
  await ctx.reply(ctx.t('help.text'));
});
