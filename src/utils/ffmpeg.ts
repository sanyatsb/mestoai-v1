// [AUDIT-H1] MP3 -> OGG/Opus for Telegram sendVoice.
// Telegram only accepts OGG/Opus for voice messages — MP3 falls back to audio
// (player UI, not the waveform pill). Edge-TTS emits MP3, so we always
// transcode before calling sendVoice.

import { spawn } from 'node:child_process';

export async function mp3ToOggOpus(mp3: Uint8Array, ffmpegPath = 'ffmpeg'): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const proc = spawn(
      ffmpegPath,
      [
        '-loglevel',
        'error',
        '-i',
        'pipe:0',
        '-c:a',
        'libopus',
        '-b:a',
        '48k',
        '-ar',
        '24000',
        '-ac',
        '1',
        '-f',
        'ogg',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    const out: Buffer[] = [];
    const errChunks: Buffer[] = [];

    proc.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));
    proc.on('error', (e) => reject(e));
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(new Uint8Array(Buffer.concat(out)));
      } else {
        const stderr = Buffer.concat(errChunks).toString('utf8');
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
      }
    });

    proc.stdin.end(Buffer.from(mp3));
  });
}
