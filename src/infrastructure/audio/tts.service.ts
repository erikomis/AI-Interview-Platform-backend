import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'stream';
import { ITTSService, SpeechAudio, WordTiming } from '../../domain/interfaces/tts.interface';
import { Interviewer } from '../../domain/entities/interview.entity';
import { toSpeechText } from './speech-text';

const EDGE_TTS_TIMEOUT_MS = 20_000;

// Neural voices per language + interviewer persona (male "Alex", female "Sofia").
// Override with TTS_VOICE_PT / TTS_VOICE_EN (male) and TTS_VOICE_PT_FEMALE /
// TTS_VOICE_EN_FEMALE (female) — list them with `MsEdgeTTS.getVoices()`.
const DEFAULT_EDGE_VOICES: Record<'pt' | 'en', Record<Interviewer, string>> = {
  pt: { male: 'pt-BR-AntonioNeural', female: 'pt-BR-ThalitaMultilingualNeural' },
  en: { male: 'en-US-AndrewMultilingualNeural', female: 'en-US-AvaMultilingualNeural' },
};

@Injectable()
export class TTSService implements ITTSService {
  private readonly logger = new Logger(TTSService.name);
  private readonly ttsPtUrl: string;
  private readonly ttsEnUrl: string;
  private readonly ttsProvider: string;
  private readonly voices: Record<'pt' | 'en', Record<Interviewer, string>>;
  private readonly rate: string;

  constructor(private readonly configService: ConfigService) {
    this.ttsPtUrl = this.configService.get('TTS_API_URL', 'http://localhost:5002');
    this.ttsEnUrl = this.configService.get('TTS_EN_API_URL', 'http://localhost:5003');
    this.ttsProvider = this.configService.get('TTS_PROVIDER', 'edge');
    this.voices = {
      pt: {
        male: this.configService.get('TTS_VOICE_PT', DEFAULT_EDGE_VOICES.pt.male),
        female: this.configService.get('TTS_VOICE_PT_FEMALE', DEFAULT_EDGE_VOICES.pt.female),
      },
      en: {
        male: this.configService.get('TTS_VOICE_EN', DEFAULT_EDGE_VOICES.en.male),
        female: this.configService.get('TTS_VOICE_EN_FEMALE', DEFAULT_EDGE_VOICES.en.female),
      },
    };
    // Relative speaking rate, e.g. "-5%" for a calmer interviewer
    this.rate = this.configService.get('TTS_RATE', '+0%');
  }

  /** Edge voice for a language + persona (unknown languages fall back to pt). */
  voiceFor(language: string, interviewer: Interviewer = 'male'): string {
    return this.voices[language === 'en' ? 'en' : 'pt'][interviewer === 'female' ? 'female' : 'male'];
  }

  async synthesize(rawText: string, language = 'pt', interviewer: Interviewer = 'male'): Promise<Buffer | null> {
    return (await this.synthesizeWithTimings(rawText, language, interviewer))?.audio ?? null;
  }

  async synthesizeWithTimings(
    rawText: string,
    language = 'pt',
    interviewer: Interviewer = 'male',
  ): Promise<SpeechAudio | null> {
    const text = toSpeechText(rawText);
    if (!text) return null;
    try {
      if (this.ttsProvider === 'edge') {
        return await this.synthesizeEdge(text, this.voiceFor(language, interviewer));
      }
      const url = language === 'en' ? this.ttsEnUrl : this.ttsPtUrl;
      const audio = this.ttsProvider === 'coqui'
        ? await this.synthesizeCoqui(text, url)
        : await this.synthesizeGeneric(text, url);
      return { audio, words: [] };
    } catch (err) {
      this.logger.warn(`TTS unavailable: ${(err as Error).message}`);
      return null;
    }
  }

  private async synthesizeEdge(text: string, voice: string): Promise<SpeechAudio> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
    const tts = new MsEdgeTTS();

    const synth = (async (): Promise<SpeechAudio> => {
      await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3, { wordBoundaryEnabled: true });
      const { audioStream, metadataStream }: { audioStream: Readable; metadataStream: Readable | null } =
        tts.toStream(text, { rate: this.rate });

      const words: WordTiming[] = [];
      metadataStream?.on('data', (chunk: Buffer) => words.push(...parseWordBoundaries(chunk.toString())));

      const audio = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        audioStream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        audioStream.on('end', () => resolve(Buffer.concat(chunks)));
        audioStream.on('error', (err: Error) => reject(err));
      });
      // Word boundaries can trail the audio slightly
      if (metadataStream && !metadataStream.readableEnded) {
        await new Promise<void>((resolve) => {
          const done = setTimeout(resolve, 300);
          metadataStream.once('end', () => { clearTimeout(done); resolve(); });
        });
      }
      return { audio, words: words.sort((x, y) => x.s - y.s) };
    })();

    // The Edge websocket can stall indefinitely — never let it block an answer
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Edge TTS timed out after ${EDGE_TTS_TIMEOUT_MS}ms`)), EDGE_TTS_TIMEOUT_MS);
    });

    try {
      return await Promise.race([synth, timeout]);
    } finally {
      clearTimeout(timer);
      synth.catch(() => {/* already timed out — swallow late rejection */});
      try { tts.close?.(); } catch { /* ignore */ }
    }
  }

  private async synthesizeCoqui(text: string, baseUrl: string): Promise<Buffer> {
    const url = new URL(`${baseUrl}/api/tts`);
    url.searchParams.set('text', text);

    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      this.logger.warn(`Coqui TTS ${res.status} GET ${url}`);
      throw new Error(`TTS error ${res.status}`);
    }

    return Buffer.from(await res.arrayBuffer());
  }

  private async synthesizeGeneric(text: string, baseUrl: string): Promise<Buffer> {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      this.logger.warn(`TTS generic ${res.status} POST ${baseUrl}`);
      throw new Error(`TTS error ${res.status}`);
    }

    return Buffer.from(await res.arrayBuffer());
  }
}

/**
 * Edge TTS metadata chunks are JSON documents with `WordBoundary` entries whose
 * offsets/durations are in 100-ns ticks. Converted to milliseconds.
 */
export function parseWordBoundaries(chunk: string): WordTiming[] {
  try {
    const doc = JSON.parse(chunk) as {
      Metadata?: Array<{ Type?: string; Data?: { Offset?: number; Duration?: number; text?: { Text?: string } } }>;
    };
    return (doc.Metadata ?? [])
      .filter((m) => m.Type === 'WordBoundary' && m.Data?.text?.Text)
      .map((m) => ({
        w: m.Data!.text!.Text!,
        s: Math.round((m.Data!.Offset ?? 0) / 10_000),
        d: Math.round((m.Data!.Duration ?? 0) / 10_000),
      }));
  } catch {
    return [];
  }
}
