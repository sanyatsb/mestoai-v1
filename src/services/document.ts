// DocumentService — extract text from uploaded PDF / DOCX / TXT / MD.
//
// [AUDIT-L7] Successful extracts log mime/size/pages/tokens/latency so we can
// see in production how big real-world docs are and where parse cost goes.
//
// Parser choice (TZ §6.5):
//   - PDF  → unpdf            (modern; needs Promise.withResolvers → Node 22)
//   - DOCX → mammoth          (clean text extraction, no formatting)
//   - TXT / Markdown → TextDecoder
//
// [AUDIT-M10] Document moderation in handleDocumentUpload is applied to the
// first 50K chars only — known limitation, recorded in audit metadata.
// Full-text chunked moderation is Phase 2.

import { extractText } from 'unpdf';
import type { DocumentText, Logger, Result, Tokenizer } from '../types.js';
import { err, ok } from '../types.js';

export const SUPPORTED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
] as const;

export type SupportedMimeType = (typeof SUPPORTED_MIME_TYPES)[number];

export type DocumentError =
  | { kind: 'too_large'; sizeMb: number; limit: number }
  | { kind: 'unsupported_format'; mimeType: string }
  | { kind: 'parse_failed'; reason: string }
  | { kind: 'too_long'; tokens: number; limit: number };

export interface ExtractTextOpts {
  fileBytes: Uint8Array;
  mimeType: string;
  /** Hard limit in MB before we even try to parse. */
  maxSizeMb: number;
}

export interface DocumentService {
  extractText(opts: ExtractTextOpts): Promise<Result<DocumentText, DocumentError>>;
}

export interface DocumentServiceDeps {
  tokenizer: Tokenizer;
  logger: Logger;
}

export function createDocumentService(deps: DocumentServiceDeps): DocumentService {
  return {
    async extractText(opts) {
      const sizeMb = opts.fileBytes.byteLength / (1024 * 1024);
      const start = Date.now();

      if (sizeMb > opts.maxSizeMb) {
        return err({ kind: 'too_large', sizeMb, limit: opts.maxSizeMb });
      }

      if (!isSupportedMime(opts.mimeType)) {
        return err({ kind: 'unsupported_format', mimeType: opts.mimeType });
      }

      try {
        let text = '';
        let pages = 1;

        if (opts.mimeType === 'application/pdf') {
          // unpdf wants a Uint8Array (or Buffer). mergePages collapses per-page
          // arrays into a single string, which is all we need downstream.
          const result = await extractText(opts.fileBytes, { mergePages: true });
          text = result.text;
          pages = result.totalPages ?? 1;
        } else if (
          opts.mimeType ===
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        ) {
          // mammoth ships as CJS; dynamic import keeps the cold-start cost off
          // anyone who only sends text/PDF.
          const mammoth = await import('mammoth');
          const buffer = Buffer.from(opts.fileBytes);
          const result = await mammoth.extractRawText({ buffer });
          text = result.value;
          pages = estimateDocxPages(text);
        } else {
          // text/plain or text/markdown
          text = new TextDecoder('utf-8').decode(opts.fileBytes);
          pages = 1;
        }

        text = text.trim();
        if (text.length === 0) {
          return err({
            kind: 'parse_failed',
            reason: 'Empty document — scanned PDFs without a text layer are not supported',
          });
        }

        const tokensEstimate = deps.tokenizer.estimate(text);

        // [AUDIT-L7] visibility for production tuning.
        deps.logger.info(
          {
            mimeType: opts.mimeType,
            sizeBytes: opts.fileBytes.byteLength,
            pages,
            tokensEstimate,
            latencyMs: Date.now() - start,
          },
          'document_extracted',
        );

        return ok({ text, pages, tokensEstimate });
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        deps.logger.warn({ err: e, mimeType: opts.mimeType }, 'document_parse_failed');
        return err({ kind: 'parse_failed', reason });
      }
    },
  };
}

function isSupportedMime(mime: string): mime is SupportedMimeType {
  return (SUPPORTED_MIME_TYPES as readonly string[]).includes(mime);
}

/**
 * mammoth doesn't report page counts (DOCX flows). Estimate at ~3000 chars
 * per page so the user sees a sensible "X pages" message — close enough for
 * UX, not used for any budgeting.
 */
function estimateDocxPages(text: string): number {
  return Math.max(1, Math.ceil(text.length / 3000));
}
