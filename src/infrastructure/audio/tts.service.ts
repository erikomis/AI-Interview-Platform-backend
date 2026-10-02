import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'stream';
import { ITTSService } from '../../domain/interfaces/tts.interface';

const EDGE_TTS_TIMEOUT_MS = 20_000;

@Injectable()
export class TTSService implements ITTSService {
  private readonly logger = new Logger(TTSService.name);
  private readonly ttsPtUrl: string;
  private readonly ttsEnUrl: string;
  private readonly ttsProvider: string;

  constructor(private readonly configService: ConfigService) {
    this.ttsPtUrl = this.configService.get('TTS_API_URL', 'http://localhost:5002');
    this.ttsEnUrl = this.configService.get('TTS_EN_API_URL', 'http://localhost:5003');
    this.ttsProvider = this.configService.get('TTS_PROVIDER', 'edge');
  }

  async synthesize(text: string, language = 'pt'): Promise<Buffer | null> {
    try {
      if (this.ttsProvider === 'edge') {
        return await this.synthesizeEdge(text, language);
      }
      const url = language === 'en' ? this.ttsEnUrl : this.ttsPtUrl;
      if (this.ttsProvider === 'coqui') {
        return await this.synthesizeCoqui(text, url);
      }
      return await this.synthesizeGeneric(text, url);
    } catch (err) {
      this.logger.warn(`TTS unavailable: ${(err as Error).message}`);
      return null;
    }
  }

  private async synthesizeEdge(text: string, language: string): Promise<Buffer> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
    const voice = language === 'en' ? 'en-US-JennyNeural' : 'pt-BR-FranciscaNeural';
    const tts = new MsEdgeTTS();

    const synth = (async (): Promise<Buffer> => {
      await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      const { audioStream }: { audioStream: Readable } = tts.toStream(text);
      return new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        audioStream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        audioStream.on('end', () => resolve(Buffer.concat(chunks)));
        audioStream.on('error', (err: Error) => reject(err));
      });
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
