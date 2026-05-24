// /start composer — Week 1 stub.
//
// Real ToS + age gate + welcome flow lands in Week 7A.

import { Composer } from 'grammy';
import type { MyContext } from '../context.js';

export const startComposer = new Composer<MyContext>();

startComposer.command('start', async (ctx) => {
  ctx.logger.info({ tgUserId: ctx.from?.id }, '/start invoked (week 1 stub)');
  await ctx.reply('Hello, world! 👋 (week 1 skeleton)');
});
