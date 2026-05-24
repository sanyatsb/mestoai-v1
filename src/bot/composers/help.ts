// /help composer — Week 1 stub.

import { Composer } from 'grammy';
import type { MyContext } from '../context.js';

export const helpComposer = new Composer<MyContext>();

helpComposer.command('help', async (ctx) => {
  await ctx.reply(
    'Gonka Bot — early skeleton.\n\n' +
      'Available now: /start, /help.\n' +
      'Chat with Kimi K2.6, voice messages, persona switching, documents — coming in later weeks.',
  );
});
