import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ISTTService } from '../../domain/interfaces/stt.interface';

@Injectable()
export class STTService implements ISTTService {
  private readonly logger = new Logger(STTService.name);
  private readonly whisperUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.whisperUrl = this.configService.get('WHISPER_API_URL', 'http://localhost:9000');
  }

  async transcribe(audioBuffer: Buffer, mimeType = 'audio/webm', language = 'pt'): Promise<string> {
    try {
      const form = new FormData();
      form.append('audio_file', new Blob([new Uint8Array(audioBuffer)], { type: mimeType }), 'audio.webm');

      const res = await fetch(
        `${this.whisperUrl}/asr?task=transcribe&language=${language}&output=json`,
        { method: 'POST', body: form, signal: AbortSignal.timeout(30_000) },
      );

      if (!res.ok) {
        const body = await res.text();
        this.logger.error(`Whisper ${res.status} POST ${this.whisperUrl}/asr — ${body}`);
        throw new Error(`STT error ${res.status}`);
      }

      const raw = await res.text();
      this.logger.log(`Whisper raw response: ${raw.slice(0, 200)}`);

      let transcript: string;
      try {
        const data = JSON.parse(raw) as { text: string };
        transcript = data.text?.trim() ?? '';
      } catch {
        // Whisper returned plain text instead of JSON
        transcript = raw.trim();
      }
      return transcript;
    } catch (err) {
      this.logger.error('STT transcription failed', err);
      throw new Error('Failed to transcribe audio');
    }
  }
}
