import { TTSService } from './tts.service';

const makeConfig = (env: Record<string, string> = {}) => ({
  get: jest.fn((key: string, fallback?: unknown) => env[key] ?? fallback),
});

describe('TTSService voice selection', () => {
  it('picks the default neural voice for each language + persona', () => {
    const sut = new TTSService(makeConfig() as any);
    expect(sut.voiceFor('pt', 'male')).toBe('pt-BR-AntonioNeural');
    expect(sut.voiceFor('pt', 'female')).toBe('pt-BR-ThalitaMultilingualNeural');
    expect(sut.voiceFor('en', 'male')).toBe('en-US-AndrewMultilingualNeural');
    expect(sut.voiceFor('en', 'female')).toBe('en-US-AvaMultilingualNeural');
  });

  it('defaults to the male voice and to Portuguese for unknown languages', () => {
    const sut = new TTSService(makeConfig() as any);
    expect(sut.voiceFor('en')).toBe('en-US-AndrewMultilingualNeural');
    expect(sut.voiceFor('es', 'female')).toBe('pt-BR-ThalitaMultilingualNeural');
  });

  it('honours env overrides for both personas', () => {
    const sut = new TTSService(makeConfig({
      TTS_VOICE_PT: 'pt-BR-Male',
      TTS_VOICE_EN: 'en-US-Male',
      TTS_VOICE_PT_FEMALE: 'pt-BR-Female',
      TTS_VOICE_EN_FEMALE: 'en-US-Female',
    }) as any);
    expect(sut.voiceFor('pt', 'male')).toBe('pt-BR-Male');
    expect(sut.voiceFor('pt', 'female')).toBe('pt-BR-Female');
    expect(sut.voiceFor('en', 'male')).toBe('en-US-Male');
    expect(sut.voiceFor('en', 'female')).toBe('en-US-Female');
  });
});
