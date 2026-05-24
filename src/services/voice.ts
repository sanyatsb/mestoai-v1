// VoiceService — speech-to-text (Whisper) and text-to-speech (Edge-TTS).
//
// [AUDIT-H1] Telegram sendVoice expects OGG/Opus; Edge-TTS emits MP3, so
// we always transcode via ffmpeg before returning bytes from synthesize().
//
// [AUDIT-L6] All msedge-tts / fetch / ffmpeg failures are caught and returned
// as Err — chat.ts treats TTS as non-fatal (text reply still goes out).
//
// [AUDIT-H7, M12] Whisper rate-limit accounting belongs to the composer
// (it increments BEFORE calling transcribe so a Whisper failure doesn't
// give the user a free retry). Size guards belong to the composer too.

import OpenAI, { toFile } from 'openai';
import type { DomainError, Logger, Result } from '../types.js';
import { err, ok } from '../types.js';
import { mp3ToOggOpus } from '../utils/ffmpeg.js';

// Edge-TTS voice IDs per UI language. Falls back to en-US if the user's
// language isn't mapped.
const VOICE_MAP = {
  en: 'en-US-AriaNeural',
  ru: 'ru-RU-SvetlanaNeural',
  es: 'es-ES-ElviraNeural',
  ar: 'ar-EG-SalmaNeural',
  zh: 'zh-CN-XiaoxiaoNeural',
  de: 'de-DE-KatjaNeural',
} as const;

export interface VoiceService {
  /**
   * language — ISO 639-1 (en, ru, ...). undefined ⇒ Whisper auto-detects.
   */
  transcribe(audioBytes: Uint8Array, language?: string): Promise<Result<string, DomainError>>;

  /**
   * Returns OGG/Opus bytes ready for ctx.replyWithVoice. Always non-empty
   * on Ok. On Err the caller should log and skip TTS without aborting the
   * text reply.
   */
  synthesize(text: string, language: string): Promise<Result<Uint8Array, DomainError>>;
}

export interface VoiceServiceDeps {
  openaiApiKey: string;
  whisperModel: string;
  /** Override ffmpeg binary path for tests. Defaults to `ffmpeg` (PATH lookup). */
  ffmpegPath?: string;
  logger: Logger;
}

export function createVoiceService(deps: VoiceServiceDeps): VoiceService {
  const openai = new OpenAI({ apiKey: deps.openaiApiKey });

  return {
    async transcribe(audioBytes, language) {
      try {
        const response = await openai.audio.transcriptions.create({
          file: await toFile(audioBytes, 'audio.ogg', { type: 'audio/ogg' }),
          model: deps.whisperModel,
          ...(language ? { language } : {}),
        });
        return ok(response.text);
      } catch (e) {
        deps.logger.warn({ err: e }, 'whisper_transcribe_failed');
        return err({ kind: 'service_unavailable', service: 'whisper' });
      }
    },

    async synthesize(text, language) {
      try {
        // msedge-tts is dynamically imported so it doesn't add ~3MB to the
        // cold start for users who never trigger TTS. The Edge service has
        // had outages in the past; dynamic import also makes it easier to
        // hot-swap to OpenAI TTS later without restarting.
        const { MsEdgeTTS, OUTPUT_FORMAT } = await import('msedge-tts');
        const tts = new MsEdgeTTS();
        const voice = VOICE_MAP[language as keyof typeof VOICE_MAP] ?? VOICE_MAP.en;
        await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
        const { audioStream } = tts.toStream(text);

        const chunks: Buffer[] = [];
        for await (const chunk of audioStream) {
          chunks.push(chunk as Buffer);
        }
        if (chunks.length === 0) {
          deps.logger.warn({ language }, 'tts_empty_audio');
          return err({ kind: 'service_unavailable', service: 'tts' });
        }
        const mp3 = new Uint8Array(Buffer.concat(chunks));

        // [AUDIT-H1] MP3 → OGG/Opus.
        const ogg = await mp3ToOggOpus(mp3, deps.ffmpegPath);
        return ok(ogg);
      } catch (e) {
        deps.logger.warn({ err: e }, 'tts_synthesize_failed');
        return err({ kind: 'service_unavailable', service: 'tts' });
      }
    },
  };
}
