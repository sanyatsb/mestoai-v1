// Exponential backoff retry helper.

export interface RetryOptions {
  retries: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Return true to retry. Defaults: any thrown error retries. */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const baseDelayMs = opts.baseDelayMs ?? 200;
  const maxDelayMs = opts.maxDelayMs ?? 5000;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt === opts.retries) break;
      if (opts.shouldRetry && !opts.shouldRetry(e, attempt)) break;

      const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      // Full jitter
      const jittered = Math.floor(Math.random() * delay);
      opts.onRetry?.(e, attempt, jittered);
      await sleep(jittered);
    }
  }
  throw lastErr;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
