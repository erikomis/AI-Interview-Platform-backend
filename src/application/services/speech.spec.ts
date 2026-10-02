import { speakBestEffort } from './speech';
import { parseWordBoundaries } from '../../infrastructure/audio/tts.service';

describe('speakBestEffort', () => {
  it('returns audio and word timings when the provider supports them', async () => {
    const tts = {
      synthesize: jest.fn(),
      synthesizeWithTimings: jest.fn().mockResolvedValue({ audio: Buffer.from('mp3'), words: [{ w: 'Olá', s: 100, d: 400 }] }),
    };
    const out = await speakBestEffort(tts, 'Olá', 'pt', 'female');
    expect(out).toEqual({ audioBase64: Buffer.from('mp3').toString('base64'), words: [{ w: 'Olá', s: 100, d: 400 }] });
    expect(tts.synthesizeWithTimings).toHaveBeenCalledWith('Olá', 'pt', 'female');
  });

  it('falls back to plain synthesis without timings', async () => {
    const tts = { synthesize: jest.fn().mockResolvedValue(Buffer.from('wav')) };
    expect(await speakBestEffort(tts, 'Hi', 'en', 'male')).toEqual({ audioBase64: Buffer.from('wav').toString('base64'), words: [] });
  });

  it('never throws when TTS fails', async () => {
    const tts = { synthesize: jest.fn().mockRejectedValue(new Error('down')) };
    expect(await speakBestEffort(tts, 'Hi', 'en', 'male')).toEqual({ audioBase64: null, words: [] });
  });
});

describe('parseWordBoundaries', () => {
  it('converts Edge 100ns ticks to milliseconds', () => {
    const chunk = JSON.stringify({
      Metadata: [{ Type: 'WordBoundary', Data: { Offset: 7375000, Duration: 4125000, text: { Text: 'Ana' } } }],
    });
    expect(parseWordBoundaries(chunk)).toEqual([{ w: 'Ana', s: 738, d: 413 }]);
  });

  it('ignores sentence boundaries and malformed chunks', () => {
    expect(parseWordBoundaries('{"Metadata":[{"Type":"SentenceBoundary","Data":{}}]}')).toEqual([]);
    expect(parseWordBoundaries('not json')).toEqual([]);
  });
});
