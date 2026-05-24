// [AUDIT-X10] services-injector middleware. Runs right after logging so
// every downstream middleware/composer can pull dependencies off of
// ctx.services.
//
// The actual service instances are constructed once at startup (in main.ts)
// and held in a closure inside the factory — no globals.

import type { MiddlewareFn } from 'grammy';
import type { BotServices, MyContext } from '../context.js';

export function createServicesInjector(services: BotServices): MiddlewareFn<MyContext> {
  return async (ctx, next) => {
    ctx.services = services;
    return next();
  };
}
