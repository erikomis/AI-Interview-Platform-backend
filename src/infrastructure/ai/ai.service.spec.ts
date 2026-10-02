import { AIService } from './ai.service';

// ── Helpers ──────────────────────────────────────────────────────────────────

const makeConfig = () => ({
  get: jest.fn((_key: string, fallback?: unknown) => fallback),
});

const okResponse = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;

const feedbackInput = {
  conversationHistory: [],
  visionMetrics: null,
  role: 'Engineer',
  candidateName: 'John',
  experienceLevel: 'mid' as const,
  sessionVariant: 1,
  language: 'en' as const,
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AIService', () => {
  let fetchMock: jest.SpyInstance;
  let sut: AIService;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
    sut = new AIService(makeConfig() as any);
  });

  afterEach(() => fetchMock.mockRestore());

  const lastRequestBody = () =>
    JSON.parse((fetchMock.mock.calls.at(-1)![1] as RequestInit).body as string) as {
      format?: string;
      messages: Array<{ role: string; content: string }>;
    };

  // ── chat() guards ────────────────────────────────────────────────────────────

  it('throws a clear error when Ollama returns an error payload', async () => {
    fetchMock.mockResolvedValue(okResponse({ error: 'model not found' }));
    await expect(sut.evaluateAnswer({ question: 'q', answer: 'a', role: 'r' })).rejects.toThrow(
      'Ollama error: model not found',
    );
  });

  it('throws when the response has no message content', async () => {
    fetchMock.mockResolvedValue(okResponse({ message: { content: '   ' } }));
    await expect(sut.evaluateAnswer({ question: 'q', answer: 'a', role: 'r' })).rejects.toThrow(
      'Ollama returned an empty response',
    );
  });

  // ── Feedback normalisation ───────────────────────────────────────────────────

  it('requests JSON mode and normalises loosely-typed feedback', async () => {
    fetchMock.mockResolvedValue(okResponse({
      message: {
        content: JSON.stringify({
          technical: '8/10',
          communication: 12,
          confidence: '7.5',
          clarity: -3,
          summary: '',
          strengths: '- Clear trade-offs\n- Good testing habits',
          improvements: ['Go deeper on caching', 42, ''],
        }),
      },
    }));

    const fb = await sut.generateFeedback(feedbackInput);

    expect(lastRequestBody().format).toBe('json');
    expect(fb.technical).toBe(8);
    expect(fb.communication).toBe(10); // clamped
    expect(fb.confidence).toBe(7.5);
    expect(fb.clarity).toBe(0);        // clamped
    expect(fb.overall).toBeCloseTo((8 + 10 + 7.5 + 0) / 4, 1); // derived when missing
    expect(fb.summary).toBe('Could not generate detailed feedback.');
    expect(fb.strengths).toEqual(['Clear trade-offs', 'Good testing habits']);
    expect(fb.improvements).toEqual(['Go deeper on caching', '42']);
  });

  it('extracts JSON wrapped in prose and falls back to defaults on garbage', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({
      message: { content: 'Here you go: {"technical": 6, "communication": 6, "confidence": 6, "clarity": 6, "overall": 6, "summary": "ok", "strengths": [], "improvements": []}' },
    }));
    expect((await sut.generateFeedback(feedbackInput)).overall).toBe(6);

    fetchMock.mockResolvedValueOnce(okResponse({ message: { content: 'not json at all' } }));
    expect((await sut.generateFeedback(feedbackInput)).overall).toBe(5);
  });

  // ── Question progression ─────────────────────────────────────────────────────

  it('numbers questions by answers given and the session length', async () => {
    fetchMock.mockResolvedValue(okResponse({ message: { content: 'Next?' } }));

    await sut.generateQuestion({
      role: 'Engineer',
      candidateName: 'John',
      language: 'en',
      maxQuestions: 5,
      conversationHistory: [
        { role: 'assistant', content: 'Q1' },
        { role: 'user', content: 'A1' },
        { role: 'assistant', content: 'Eval 1' },
        { role: 'assistant', content: 'Q2' },
        { role: 'user', content: 'A2' },
        { role: 'assistant', content: 'Eval 2' },
      ],
    });

    const prompt = lastRequestBody().messages.at(-1)!.content;
    expect(prompt).toContain('Question 3/5');
  });
});
