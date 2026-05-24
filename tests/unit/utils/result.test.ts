import { describe, expect, it } from 'vitest';
import { err, isErr, isOk, ok, unwrap } from '../../../src/utils/result.js';

describe('Result helpers', () => {
  it('ok/err narrow correctly', () => {
    const good = ok(42);
    const bad = err('boom');
    expect(isOk(good)).toBe(true);
    expect(isErr(bad)).toBe(true);
    if (isOk(good)) expect(good.value).toBe(42);
    if (isErr(bad)) expect(bad.error).toBe('boom');
  });

  it('unwrap returns value on Ok, throws on Err', () => {
    expect(unwrap(ok('hi'))).toBe('hi');
    expect(() => unwrap(err('nope'))).toThrow(/unwrap on Err/);
  });
});
