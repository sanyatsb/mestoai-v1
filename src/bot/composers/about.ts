// /about — short bot info. Allowed in BOTH private and group chats.
//
// We pull the version from package.json at startup time (read once, cached)
// so the about-text {version} placeholder always reflects what's deployed.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Composer } from 'grammy';
import type { MyContext } from '../context.js';

export const aboutComposer = new Composer<MyContext>();

const VERSION = loadVersion();

aboutComposer.command('about', async (ctx) => {
  await ctx.reply(ctx.t('about.text', { version: VERSION }));
});

function loadVersion(): string {
  try {
    // package.json sits two directories above src/bot/composers/about.ts.
    const pkgUrl = new URL('../../../package.json', import.meta.url);
    const raw = readFileSync(fileURLToPath(pkgUrl), 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
