// GonkaClient — wrapper over the OpenAI-compatible mingles.ai gateway.
//
// [AUDIT-H2] SSE parsing via `eventsource-parser` (battle-tested, ~5KB).
// [AUDIT-H3, L13] Token counts come from gateway `usage` in the final chunk.
// If usage is missing we still complete (with a warn) and the caller falls
// back to tiktoken — see chat composer / cost tracker.
// [AUDIT-N1 callers] On 4xx we don't retry — those are deterministic errors.
// 5xx + network errors get up to maxRetries exponential-backoff retries.

import { type EventSourceMessage, createParser } from 'eventsource-parser';
import type { DomainError, Logger, Result } from '../types.js';
import { err, ok } from '../types.js';
import { withRetry } from '../utils/retry.js';

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface StreamChunk {
  /** Incremental text appended this chunk (may be empty). */
  delta: string;
  /** Populated only on the final chunk, when the gateway sent `usage`. */
  tokensInput?: number;
  tokensOutput?: number;
  finishReason?: 'stop' | 'length' | 'content_filter' | null;
  done: boolean;
}

export interface ChatStreamOptions {
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface ChatCompleteResult {
  content: string;
  tokensInput: number;
  tokensOutput: number;
}

export interface GonkaClient {
  /** Streaming. AsyncIterable of incremental chunks ending with done: true. */
  chatStream(opts: ChatStreamOptions): AsyncIterable<StreamChunk>;
  /** Non-streaming convenience for short calls (e.g. auto-title). */
  chatComplete(
    opts: Omit<ChatStreamOptions, 'signal'>,
  ): Promise<Result<ChatCompleteResult, DomainError>>;
}

export interface GonkaClientConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  maxRetries?: number;
  logger: Logger;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 2;
// Kimi-K2.6 on Gonka caps max_completion_tokens at 2048; sending higher
// returns 4xx. Callers can override via opts.maxTokens up to that ceiling.
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TEMPERATURE = 0.7;

// Minimal slice of the OpenAI streaming response we use.
interface GatewayStreamEvent {
  choices?: Array<{
    delta?: { content?: string; role?: string };
    finish_reason?: 'stop' | 'length' | 'content_filter' | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function createGonkaClient(config: GonkaClientConfig): GonkaClient {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  const buildBody = (opts: ChatStreamOptions, stream: boolean): string =>
    JSON.stringify({
      model: config.model,
      messages: opts.messages,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
      stream,
      stream_options: stream ? { include_usage: true } : undefined,
    });

  const headers = (): Record<string, string> => ({
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  });

  /**
   * One attempt at the HTTP request. Returns the live Response so the caller
   * can either iterate (stream) or .json() (complete).
   */
  const doFetch = async (
    body: string,
    signal: AbortSignal | undefined,
    accept: 'event-stream' | 'json',
  ): Promise<Response> => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('gonka_timeout')), timeoutMs);
    // If the caller also passed an AbortSignal, forward it.
    if (signal) {
      const forward = () => ac.abort(signal.reason);
      if (signal.aborted) forward();
      else signal.addEventListener('abort', forward, { once: true });
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          ...headers(),
          Accept: accept === 'event-stream' ? 'text/event-stream' : 'application/json',
        },
        body,
        signal: ac.signal,
      });
      return res;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    chatStream(opts) {
      const body = buildBody(opts, true);
      const signal = opts.signal;
      const logger = config.logger;
      const requestStart = Date.now();

      // We expose an async iterator over StreamChunk. Inside we call fetch
      // with retry policy, then drive the SSE parser.
      return {
        async *[Symbol.asyncIterator]() {
          // Retry the fetch+stream START. We don't retry mid-stream — once
          // we've yielded data, the caller has already moved on.
          let res: Response | null = null;
          await withRetry(
            async () => {
              const r = await doFetch(body, signal, 'event-stream');
              if (r.status >= 500) {
                throw new Error(`gateway_5xx_${r.status}`);
              }
              if (!r.ok) {
                // 4xx → bubble out without retry
                const text = await r.text().catch(() => '');
                const e = new Error(`gateway_4xx_${r.status}: ${text.slice(0, 200)}`);
                (e as Error & { noRetry?: boolean }).noRetry = true;
                throw e;
              }
              if (!r.body) throw new Error('gateway_empty_body');
              res = r;
            },
            {
              retries: maxRetries,
              shouldRetry: (e) => !(e as { noRetry?: boolean }).noRetry,
              onRetry: (e, attempt, delayMs) =>
                logger.warn({ err: e, attempt, delayMs }, 'gonka_retry'),
            },
          );

          if (!res) {
            // Shouldn't happen — withRetry would have thrown.
            throw new Error('gonka_no_response');
          }
          const response = res as Response;

          let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
          let finishReason: StreamChunk['finishReason'] = null;
          const pending: StreamChunk[] = [];
          let doneSeen = false;

          const parser = createParser({
            onEvent(event: EventSourceMessage) {
              if (event.data === '[DONE]') {
                doneSeen = true;
                return;
              }
              let parsed: GatewayStreamEvent;
              try {
                parsed = JSON.parse(event.data) as GatewayStreamEvent;
              } catch (e) {
                logger.warn({ err: e, data: event.data.slice(0, 200) }, 'sse_parse_error');
                return;
              }
              const choice = parsed.choices?.[0];
              const delta = choice?.delta?.content ?? '';
              if (choice?.finish_reason) finishReason = choice.finish_reason;
              if (parsed.usage) usage = parsed.usage;
              if (delta || choice?.finish_reason) {
                pending.push({ delta, done: false });
              }
            },
          });

          // response.body is guaranteed by the earlier 'gateway_empty_body'
          // check above; this assertion is for type narrowing only.
          if (!response.body) throw new Error('gateway_empty_body_post_check');
          const reader = response.body.getReader();
          const decoder = new TextDecoder();

          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              parser.feed(decoder.decode(value, { stream: true }));
              while (pending.length > 0) {
                const chunk = pending.shift();
                if (chunk) yield chunk;
              }
            }
          } finally {
            try {
              reader.releaseLock();
            } catch {
              // ignore
            }
          }

          if (!doneSeen) {
            logger.warn('sse_stream_ended_without_done');
          }

          // Final chunk carries finish_reason and (ideally) usage.
          const finalChunk: StreamChunk = {
            delta: '',
            done: true,
            finishReason,
            ...(usage?.prompt_tokens != null ? { tokensInput: usage.prompt_tokens } : {}),
            ...(usage?.completion_tokens != null ? { tokensOutput: usage.completion_tokens } : {}),
          };
          logger.info(
            {
              durationMs: Date.now() - requestStart,
              tokensInput: finalChunk.tokensInput,
              tokensOutput: finalChunk.tokensOutput,
              usageDegraded: usage == null,
            },
            'gonka_stream_done',
          );
          yield finalChunk;
        },
      };
    },

    async chatComplete(opts) {
      const body = buildBody({ ...opts, signal: undefined as never }, false);
      try {
        let res: Response | null = null;
        await withRetry(
          async () => {
            const r = await doFetch(body, undefined, 'json');
            if (r.status >= 500) throw new Error(`gateway_5xx_${r.status}`);
            if (!r.ok) {
              const text = await r.text().catch(() => '');
              const e = new Error(`gateway_4xx_${r.status}: ${text.slice(0, 200)}`);
              (e as Error & { noRetry?: boolean }).noRetry = true;
              throw e;
            }
            res = r;
          },
          {
            retries: maxRetries,
            shouldRetry: (e) => !(e as { noRetry?: boolean }).noRetry,
            onRetry: (e, attempt, delayMs) =>
              config.logger.warn({ err: e, attempt, delayMs }, 'gonka_complete_retry'),
          },
        );

        if (!res) return err({ kind: 'service_unavailable', service: 'gonka' });
        const response = res as Response;
        const parsed = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const content = parsed.choices?.[0]?.message?.content ?? '';
        return ok({
          content,
          tokensInput: parsed.usage?.prompt_tokens ?? 0,
          tokensOutput: parsed.usage?.completion_tokens ?? 0,
        });
      } catch (e) {
        config.logger.error({ err: e }, 'gonka_complete_failed');
        return err({ kind: 'service_unavailable', service: 'gonka' });
      }
    },
  };
}
