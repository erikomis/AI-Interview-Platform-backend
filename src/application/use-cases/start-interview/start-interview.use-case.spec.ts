import { StartInterviewUseCase } from './start-interview.use-case';
import { Interview } from '../../../domain/entities/interview.entity';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Creates a thenable Drizzle-like chain that resolves to `value`. */
function dbChain(value: unknown): any {
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_, prop) {
      if (prop === 'then') {
        return (ok: (v: unknown) => unknown, fail: (e: unknown) => unknown) =>
          Promise.resolve(value).then(ok, fail);
      }
      return () => new Proxy({} as Record<string, unknown>, handler);
    },
  };
  return new Proxy({} as Record<string, unknown>, handler);
}

const makeInsertChain = () => ({
  values: jest.fn().mockResolvedValue([]),
});

const makeAiService = () => ({
  generateQuestion: jest.fn().mockResolvedValue('Tell me about yourself'),
  evaluateAnswer: jest.fn(),
  generateFeedback: jest.fn(),
});

const makeTtsService = () => ({
  synthesize: jest.fn().mockResolvedValue(Buffer.from('audio-data')),
});

const makeRedisService = () => ({
  set: jest.fn().mockResolvedValue(undefined),
  get: jest.fn().mockResolvedValue(null),
  del: jest.fn().mockResolvedValue(undefined),
  exists: jest.fn().mockResolvedValue(false),
});

const makeDrizzleService = () => {
  const insertChain = makeInsertChain();
  return {
    db: {
      select: jest.fn().mockReturnValue(dbChain([])), // prevInterviews = []
      insert: jest.fn().mockReturnValue(insertChain),
    },
    _insertChain: insertChain,
  };
};

const baseDto = {
  candidateId: 'John Doe',
  role: 'Software Engineer',
  language: 'en' as const,
  experienceLevel: 'mid' as const,
  userId: 'user-abc',
  sessionMode: 'full' as const,
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe('StartInterviewUseCase', () => {
  let sut: StartInterviewUseCase;
  let aiService: ReturnType<typeof makeAiService>;
  let ttsService: ReturnType<typeof makeTtsService>;
  let redisService: ReturnType<typeof makeRedisService>;
  let drizzleService: ReturnType<typeof makeDrizzleService>;

  beforeEach(() => {
    aiService = makeAiService();
    ttsService = makeTtsService();
    redisService = makeRedisService();
    drizzleService = makeDrizzleService();

    sut = new StartInterviewUseCase(
      aiService as any,
      ttsService as any,
      redisService as any,
      drizzleService as any,
    );
  });

  it('creates an Interview instance and returns the first question', async () => {
    const result = await sut.execute(baseDto);

    expect(result.interview).toBeInstanceOf(Interview);
    expect(result.firstQuestion).toBe('Tell me about yourself');
    expect(aiService.generateQuestion).toHaveBeenCalledTimes(1);
  });

  it('passes role and candidateName to the AI service', async () => {
    await sut.execute(baseDto);

    expect(aiService.generateQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'Software Engineer',
        candidateName: 'John Doe',
        language: 'en',
        experienceLevel: 'mid',
      }),
    );
  });

  it('saves interview state to Redis with 1-hour TTL', async () => {
    const result = await sut.execute(baseDto);

    expect(redisService.set).toHaveBeenCalledWith(
      `interview:${result.interview.id}`,
      expect.any(String),
      3600,
    );
  });

  it('inserts the interview row into the database', async () => {
    await sut.execute(baseDto);

    expect(drizzleService.db.insert).toHaveBeenCalled();
    expect(drizzleService._insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'Software Engineer',
        userId: 'user-abc',
        status: 'in_progress',
      }),
    );
  });

  it.each([
    ['practice', 5],
    ['full', 10],
    ['intensive', 15],
  ])('sets maxQuestions=%d for sessionMode=%s', async (mode, expected) => {
    const result = await sut.execute({ ...baseDto, sessionMode: mode as any });
    expect(result.interview.maxQuestions).toBe(expected);
  });

  it('returns audioBase64 when TTS succeeds', async () => {
    const result = await sut.execute(baseDto);
    expect(result.audioBase64).toBe(Buffer.from('audio-data').toString('base64'));
  });

  it('returns null audioBase64 when TTS fails (best-effort)', async () => {
    ttsService.synthesize.mockRejectedValue(new Error('TTS unavailable'));
    const result = await sut.execute(baseDto);
    expect(result.audioBase64).toBeNull();
  });

  it('passes cvSummary as cvContext to the AI', async () => {
    await sut.execute({ ...baseDto, cvSummary: 'Senior dev with 8 years experience' });

    expect(aiService.generateQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ cvContext: 'Senior dev with 8 years experience' }),
    );
  });

  it('adds first question as an interviewer message on the interview', async () => {
    const result = await sut.execute(baseDto);

    const interviewerMsgs = result.interview.messages.filter((m) => m.role === 'interviewer');
    expect(interviewerMsgs).toHaveLength(1);
    expect(interviewerMsgs[0].content).toBe('Tell me about yourself');
  });

  it('passes previousTopics from prior sessions to the AI', async () => {
    // Simulate 2 previous sessions with covered topics
    const prevRows = [
      { topicsCovered: ['mid-variant1'] },
      { topicsCovered: ['mid-variant2'] },
    ];
    drizzleService.db.select.mockReturnValue(dbChain(prevRows));

    await sut.execute(baseDto);

    expect(aiService.generateQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        previousTopics: expect.arrayContaining(['mid-variant1', 'mid-variant2']),
      }),
    );
  });
});
