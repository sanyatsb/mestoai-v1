import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGonkaClient } from '../../../src/services/gonka-client.js';

const silentLogger = {
  child: () => silentLogger,
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  // biome-ignore lint/suspicious/noExplicitAny: minimal pino-like stub
} as any;

/**
 * Build a Response whose body streams the given SSE chunks. Each chunk is
 * emitted as a separate read so we exercise the parser's buffering across
 * TCP boundaries.
 */
function sseResponse(chunks: string[]): Response {
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      const chunk = chunks[i] ?? '';
      i += 1;
      controller.enqueue(new TextEncoder().encode(chunk));
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('GonkaClient.chatStream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('parses SSE chunks split across reads and yields deltas + usage', async () => {
    // The 'Прив'/'ет' delta is intentionally split across reads to verify the
    // parser keeps the partial event buffered until \n\n arrives.
    const events = [
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Прив"}}]}\n',
      '\ndata: {"choices":[{"delta":{"content":"ет"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":15,"completion_tokens":7}}\n\n',
      'data: [DONE]\n\n',
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(events)));

    const client = createGonkaClient({
      baseUrl: 'https://gateway.test/v1',
      apiKey: 'k',
      model: 'Kimi-K2.6',
      logger: silentLogger,
    });
    const chunks: Array<{
      delta: string;
      done: boolean;
      tokensInput?: number;
      tokensOutput?: number;
    }> = [];
    for await (const c of client.chatStream({ messages: [{ role: 'user', content: 'hi' }] })) {
      chunks.push({
        delta: c.delta,
        done: c.done,
        ...(c.tokensInput !== undefined ? { tokensInput: c.tokensInput } : {}),
        ...(c.tokensOutput !== undefined ? { tokensOutput: c.tokensOutput } : {}),
      });
    }

    const text = chunks.map((c) => c.delta).join('');
    expect(text).toBe('Привет');
    const last = chunks[chunks.length - 1];
    expect(last?.done).toBe(true);
    expect(last?.tokensInput).toBe(15);
    expect(last?.tokensOutput).toBe(7);
  });

  it('completes without usage and marks the final chunk done anyway', async () => {
    // Gateway sometimes omits the usage object — caller falls back to tiktoken.
    const events = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(events)));
    const client = createGonkaClient({
      baseUrl: 'https://gateway.test/v1',
      apiKey: 'k',
      model: 'Kimi-K2.6',
      logger: silentLogger,
    });
    const chunks = [];
    for await (const c of client.chatStream({ messages: [{ role: 'user', content: 'x' }] })) {
      chunks.push(c);
    }
    const last = chunks[chunks.length - 1];
    expect(last?.done).toBe(true);
    expect(last?.tokensInput).toBeUndefined();
    expect(last?.tokensOutput).toBeUndefined();
  });

  it('does not retry 4xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('bad request', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = createGonkaClient({
      baseUrl: 'https://gateway.test/v1',
      apiKey: 'k',
      model: 'Kimi-K2.6',
      maxRetries: 3,
      logger: silentLogger,
    });
    await expect(async () => {
      for await (const _ of client.chatStream({ messages: [{ role: 'user', content: 'x' }] })) {
        // noop
      }
    }).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
