export interface ITTSService {
  synthesize(text: string, language?: string): Promise<Buffer | null>;
}
