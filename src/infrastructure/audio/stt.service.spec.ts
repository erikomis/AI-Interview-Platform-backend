import { STTService, cleanTranscript } from './stt.service';
import { buildSttPrompt } from '../../application/services/stt-prompt';

describe('cleanTranscript', () => {
  it('drops subtitle-credit hallucinations Whisper produces on silence', () => {
    expect(cleanTranscript(' Legendas pela comunidade Amara.org ')).toBe('');
    expect(cleanTranscript('Obrigado por assistir!')).toBe('');
    expect(cleanTranscript('Thanks for watching.')).toBe('');
  });

  it('keeps real speech and strips trailing credits', () => {
    expect(cleanTranscript('Eu usaria Redis como cache. Legendas pela comunidade Amara.org'))
      .toBe('Eu usaria Redis como cache.');
  });

  it('treats punctuation-only output as empty', () => {
    expect(cleanTranscript(' ... ')).toBe('');
  });
});

describe('STTService', () => {
  let fetchMock: jest.SpyInstance;
  const sut = new STTService({ get: (_k: string, fallback: unknown) => fallback } as any);

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ text: ' Eu usaria Redis. ' }),
    } as Response);
  });
  afterEach(() => fetchMock.mockRestore());

  it('sends language, VAD filter and the context prompt to Whisper', async () => {
    const text = await sut.transcribe(Buffer.from('x'), 'audio/webm;codecs=opus', 'pt', 'Entrevista técnica')
    expect(text).toBe('Eu usaria Redis.');
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get('language')).toBe('pt');
    expect(url.searchParams.get('vad_filter')).toBe('true');
    expect(url.searchParams.get('initial_prompt')).toBe('Entrevista técnica');
    const file = ((fetchMock.mock.calls[0][1] as RequestInit).body as FormData).get('audio_file') as File;
    expect(file.name).toBe('audio.webm');
  });

  it('names Safari recordings as m4a', async () => {
    await sut.transcribe(Buffer.from('x'), 'audio/mp4', 'pt');
    const file = ((fetchMock.mock.calls[0][1] as RequestInit).body as FormData).get('audio_file') as File;
    expect(file.name).toBe('audio.m4a');
  });
});

describe('buildSttPrompt', () => {
  it('includes the role, the current question and technical terms', () => {
    const prompt = buildSttPrompt({ language: 'pt', role: 'Desenvolvedor Backend', currentQuestion: 'Como você usaria filas?' } as any);
    expect(prompt).toContain('Desenvolvedor Backend');
    expect(prompt).toContain('Como você usaria filas?');
    expect(prompt).toContain('Redis');
  });
});
