export interface ISTTService {
  transcribe(audioBuffer: Buffer, mimeType?: string, language?: string): Promise<string>;
}
