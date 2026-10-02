/** Thrown when the speech-to-text backend fails (unreachable, non-2xx, timeout). */
export class TranscriptionFailedError extends Error {
  constructor(message = 'Failed to transcribe audio') {
    super(message);
    this.name = 'TranscriptionFailedError';
  }
}

export interface ISTTService {
  transcribe(audioBuffer: Buffer, mimeType?: string, language?: string): Promise<string>;
}
