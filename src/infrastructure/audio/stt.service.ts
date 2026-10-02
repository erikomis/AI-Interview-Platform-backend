import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ISTTService, TranscriptionFailedError } from '../../domain/interfaces/stt.interface';

// Whisper's initial_prompt is truncated to ~224 tokens; keep the context short
const MAX_PROMPT_CHARS = 600;

const EXTENSION_BY_MIME: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
};

/**
 * Phrases Whisper is known to "hear" in silence or noise (it was trained on
 * subtitled video). A transcript made only of these is treated as empty.
 */
const HALLUCINATIONS = [
  /legendas? (pela|por) comunidade amara\.org/i,
  /legendado por/i,
  /obrigad[oa] por assistir/i,
  /inscreva-se no canal/i,
  /subtitles? by the amara\.org community/i,
  /thank(s| you) for watching/i,
  /please subscribe/i,
];

/** Strips subtitle-credit hallucinations; returns '' when nothing real is left. */
export function cleanTranscript(text: string): string {
  let out = text.trim();
  for (const re of HALLUCINATIONS) out = out.replace(re, ' ');
  out = out.replace(/\s{2,}/g, ' ').trim();
  // Only punctuation / filler left (e.g. "...", "-", "Hmm.")
  return /[\p{L}\p{N}]{2,}/u.test(out) ? out : '';
}

@Injectable()
export class STTService implements ISTTService {
  private readonly logger = new Logger(STTService.name);
  private readonly whisperUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.whisperUrl = this.configService.get('WHISPER_API_URL', 'http://localhost:9000');
  }

  async transcribe(audioBuffer: Buffer, mimeType = 'audio/webm', language = 'pt', prompt?: string): Promise<string> {
    try {
      const baseMime = mimeType.split(';')[0].trim().toLowerCase();
      const form = new FormData();
      form.append(
        'audio_file',
        new Blob([new Uint8Array(audioBuffer)], { type: baseMime }),
        `audio.${EXTENSION_BY_MIME[baseMime] ?? 'webm'}`,
      );

      const params = new URLSearchParams({
        task: 'transcribe',
        language,
        output: 'json',
        // Skip silence/noise segments — the main source of invented words
        vad_filter: 'true',
      });
      if (prompt) params.set('initial_prompt', prompt.slice(0, MAX_PROMPT_CHARS));

      const res = await fetch(`${this.whisperUrl}/asr?${params}`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(60_000),
      });

      if (!res.ok) {
        const body = await res.text();
        this.logger.error(`Whisper ${res.status} POST ${this.whisperUrl}/asr — ${body}`);
        throw new Error(`STT error ${res.status}`);
      }

      const raw = await res.text();
      let transcript: string;
      try {
        const data = JSON.parse(raw) as { text: string };
        transcript = data.text ?? '';
      } catch {
        // Whisper returned plain text instead of JSON
        transcript = raw;
      }
      return cleanTranscript(transcript);
    } catch (err) {
      this.logger.error('STT transcription failed', err);
      throw new TranscriptionFailedError();
    }
  }
}
