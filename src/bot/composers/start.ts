// /start composer — Week 2 stub.
//
// Week 7A wires the full ToS + age-gate + welcome flow on top of this.

import { Composer } from 'grammy';
import type { MyContext } from '../context.js';

export const startComposer = new Composer<MyContext>();

startComposer.command('start', async (ctx) => {
  ctx.logger.info({ tgUserId: ctx.from?.id }, '/start invoked');
  await ctx.reply(ctx.t('welcome.text'));
});
