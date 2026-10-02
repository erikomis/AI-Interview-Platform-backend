import {
  AIService,
  PROGRESSION_EN,
  PROGRESSION_PT,
  VARIANT_FOCUS_EN,
  VARIANT_FOCUS_PT,
  evaluationSystemPromptEn,
  evaluationSystemPromptPt,
  systemPromptEn,
  systemPromptPt,
} from './ai.service';
import { AIUnavailableError } from '../../domain/interfaces/ai.interface';

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
      options: { temperature: number; num_ctx: number; num_predict?: number };
    };

  // ── spoken replies ───────────────────────────────────────────────────────────

  it('strips labels, quotes and markdown from evaluations that will be spoken', async () => {
    fetchMock.mockResolvedValue(okResponse({ message: { content: '"Avaliação: Você explicou bem o uso de **índices** no Postgres."' } }));
    const reply = await sut.evaluateAnswer({ question: 'q', answer: 'a', role: 'r' });
    expect(reply).toBe('Você explicou bem o uso de índices no Postgres.');
  });

  it('asks Ollama for a large context window so the system prompt is not truncated', async () => {
    fetchMock.mockResolvedValue(okResponse({ message: { content: 'Pergunta: Como você usaria filas?' } }));
    const q = await sut.generateQuestion({ role: 'r', candidateName: 'Ana', conversationHistory: [] });
    expect(q).toBe('Como você usaria filas?');
    expect((lastRequestBody() as unknown as { options: { num_ctx: number } }).options.num_ctx).toBeGreaterThanOrEqual(8192);
  });

  // ── chat() guards ────────────────────────────────────────────────────────────

  it('throws a clear error when Ollama returns an error payload', async () => {
    fetchMock.mockResolvedValue(okResponse({ error: 'model not found' }));
    await expect(sut.evaluateAnswer({ question: 'q', answer: 'a', role: 'r' })).rejects.toThrow(
      'Ollama error: model not found',
    );
  });

  it('throws AIUnavailableError when Ollama is unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(sut.evaluateAnswer({ question: 'q', answer: 'a', role: 'r' })).rejects.toBeInstanceOf(AIUnavailableError);
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

  it('extracts JSON wrapped in prose', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({
      message: { content: 'Here you go: {"technical": 6, "communication": 6, "confidence": 6, "clarity": 6, "overall": 6, "summary": "ok", "strengths": [], "improvements": []}' },
    }));
    expect((await sut.generateFeedback(feedbackInput)).overall).toBe(6);
  });

  it('throws (instead of inventing 5/10 scores) when the feedback is not JSON', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ message: { content: 'not json at all' } }));
    await expect(sut.generateFeedback(feedbackInput)).rejects.toThrow(/feedback/i);
  });

  it('throws when the JSON has no score fields at all', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({
      message: { content: JSON.stringify({ summary: 'Great job', strengths: ['x'], improvements: [] }) },
    }));
    await expect(sut.generateFeedback(feedbackInput)).rejects.toThrow();
  });

  it('unwraps feedback the model nested under a key', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({
      message: {
        content: JSON.stringify({
          feedback: { technical: 7, communication: 8, confidence: 6, clarity: 7, overall: 7, summary: 'Solid', strengths: ['a'], improvements: ['b'] },
        }),
      },
    }));
    const fb = await sut.generateFeedback(feedbackInput);
    expect(fb).toMatchObject({ technical: 7, communication: 8, overall: 7, summary: 'Solid', strengths: ['a'], improvements: ['b'] });
  });

  it('keeps top-level summary/lists when only the scores are nested', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({
      message: {
        content: JSON.stringify({
          scores: { technical: 9, communication: 7 },
          summary: 'Strong',
          strengths: ['depth'],
          improvements: ['pace'],
        }),
      },
    }));
    const fb = await sut.generateFeedback(feedbackInput);
    expect(fb.technical).toBe(9);
    expect(fb.overall).toBe(8);
    // Missing categories take the overall score, never a made-up constant
    expect(fb.confidence).toBe(8);
    expect(fb.clarity).toBe(8);
    expect(fb.summary).toBe('Strong');
  });

  // ── Evaluations ─────────────────────────────────────────────────────────────

  describe('evaluateAnswer', () => {
    it('uses its own short, low-temperature generation settings', async () => {
      fetchMock.mockResolvedValue(okResponse({ message: { content: 'Good point about indexes.' } }));
      await sut.evaluateAnswer({ question: 'q', answer: 'a', role: 'r', language: 'en' });

      const body = lastRequestBody();
      expect(body.options.temperature).toBe(0.5);
      expect(body.options.num_predict).toBe(160);
      expect(body.options.num_ctx).toBeGreaterThanOrEqual(8192);
      expect(body.messages[0].content).toBe(evaluationSystemPromptEn('male'));
    });

    it('drops trailing questions so only the next-question turn asks anything', async () => {
      fetchMock.mockResolvedValue(okResponse({
        message: { content: 'You covered B-trees well. But what about hash indexes? Can you elaborate?' },
      }));
      expect(await sut.evaluateAnswer({ question: 'q', answer: 'a', role: 'r', language: 'en' }))
        .toBe('You covered B-trees well.');
    });

    it('adds a final period and keeps decimals intact', async () => {
      fetchMock.mockResolvedValue(okResponse({ message: { content: 'Você citou o Node 2.5 corretamente' } }));
      expect(await sut.evaluateAnswer({ question: 'q', answer: 'a', role: 'r' }))
        .toBe('Você citou o Node 2.5 corretamente.');
    });

    it('falls back to a neutral transition when the whole reply is a question', async () => {
      fetchMock.mockResolvedValue(okResponse({ message: { content: 'Pode detalhar melhor?' } }));
      expect(await sut.evaluateAnswer({ question: 'q', answer: 'a', role: 'r' })).toBe('Certo, vamos seguir.');
    });

    it('uses the persona-aware evaluation prompt', async () => {
      fetchMock.mockResolvedValue(okResponse({ message: { content: 'Boa resposta.' } }));
      await sut.evaluateAnswer({ question: 'q', answer: 'a', role: 'r', language: 'pt', interviewer: 'female' });
      expect(lastRequestBody().messages[0].content).toBe(evaluationSystemPromptPt('female'));
    });
  });

  // ── Persona ─────────────────────────────────────────────────────────────────

  describe('interviewer persona', () => {
    it('builds gendered PT prompts and named EN prompts', () => {
      expect(systemPromptPt('male')).toContain('Você é Alex, um entrevistador técnico sênior');
      expect(systemPromptPt('female')).toContain('Você é Sofia, uma entrevistadora técnica sênior');
      expect(systemPromptPt('female')).toContain('Seja direta, analítica e exigente');
      expect(systemPromptPt('female')).not.toMatch(/Alex|entrevistador técnico/);
      expect(systemPromptEn('male')).toContain('You are Alex');
      expect(systemPromptEn('female')).toContain('You are Sofia');
      expect(evaluationSystemPromptPt('female')).toContain('Você é Sofia, uma entrevistadora técnica sênior');
    });

    it('evaluation prompts forbid questions and omit the follow-up guideline', () => {
      for (const prompt of [evaluationSystemPromptPt('male'), evaluationSystemPromptEn('female')]) {
        expect(prompt).toMatch(/NUNCA faça perguntas|NEVER ask any question/);
        expect(prompt).not.toMatch(/follow-up|follow up/i);
      }
    });

    it('introduces the female interviewer as Sofia in the first question', async () => {
      fetchMock.mockResolvedValue(okResponse({ message: { content: 'Olá, Ana, eu sou a Sofia. Como você começou?' } }));
      await sut.generateQuestion({ role: 'Dev', candidateName: 'Ana', conversationHistory: [], interviewer: 'female' });

      const body = lastRequestBody();
      expect(body.messages[0].content).toBe(systemPromptPt('female'));
      expect(body.messages.at(-1)!.content).toContain('eu sou a Sofia');
    });

    it('defaults to Alex', async () => {
      fetchMock.mockResolvedValue(okResponse({ message: { content: 'Hi John, I am Alex. Q?' } }));
      await sut.generateQuestion({ role: 'Dev', candidateName: 'John', conversationHistory: [], language: 'en' });
      expect(lastRequestBody().messages.at(-1)!.content).toContain("I'm Alex");
    });

    it('passes the persona to feedback generation', async () => {
      fetchMock.mockResolvedValue(okResponse({ message: { content: JSON.stringify({ technical: 5, communication: 5, confidence: 5, clarity: 5, overall: 5, summary: 's', strengths: [], improvements: [] }) } }));
      await sut.generateFeedback({ ...feedbackInput, interviewer: 'female' });
      expect(lastRequestBody().messages[0].content).toBe(systemPromptEn('female'));
    });
  });

  // ── Progression hints ───────────────────────────────────────────────────────

  it('progression hints are topics: no bundled questions and no live coding', () => {
    const hints = [PROGRESSION_PT, PROGRESSION_EN].flatMap((byLevel) =>
      Object.values(byLevel).flatMap((byVariant) => Object.values(byVariant).flat()),
    );
    expect(hints).toHaveLength(2 * 3 * 3 * 10);
    for (const text of [...hints, ...Object.values(VARIANT_FOCUS_PT), ...Object.values(VARIANT_FOCUS_EN)]) {
      expect(text).not.toContain('?');
      expect(text).not.toMatch(/live coding/i);
    }
    expect(hints.filter((h) => /^(resolução verbal|verbal problem solving):/.test(h)).length).toBeGreaterThan(0);
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
    expect(prompt).toContain('question 3 of 5');
    // Prose, not a "Label: x | Label: y" header the model would echo back
    expect(prompt).not.toContain('|');
    expect(prompt).toMatch(/exactly ONE short question that ends with a single question mark/);
  });
});
