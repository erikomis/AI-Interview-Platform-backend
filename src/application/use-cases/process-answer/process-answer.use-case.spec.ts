import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ProcessAnswerUseCase } from './process-answer.use-case';
import { Interview } from '../../../domain/entities/interview.entity';

// ── Helpers ──────────────────────────────────────────────────────────────────

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

/** Builds a serialised Interview that belongs to `userId`. */
function makeInterviewJson(userId: string, interviewerMessages = 1): string {
  const interview = new Interview('John', 'Engineer', 'en', 'mid', userId, 10);
  interview.start();
  for (let i = 0; i < interviewerMessages; i++) {
    interview.addMessage('interviewer', `Question ${i + 1}`);
  }
  interview.setCurrentQuestion(`Question ${interviewerMessages}`);
  return JSON.stringify(interview);
}

const makeAiService = () => ({
  evaluateAnswer: jest.fn().mockResolvedValue('Good answer! Here is my feedback.'),
  generateQuestion: jest.fn().mockResolvedValue('Next question?'),
  generateFeedback: jest.fn(),
});

const makeTtsService = () => ({
  synthesize: jest.fn().mockResolvedValue(Buffer.from('audio')),
});

const makeRedisService = (raw: string | null = null) => ({
  set: jest.fn().mockResolvedValue(undefined),
  get: jest.fn().mockResolvedValue(raw),
  del: jest.fn().mockResolvedValue(undefined),
  exists: jest.fn().mockResolvedValue(false),
});

const makeDrizzleService = (interviewRow?: Record<string, unknown>, msgRows: unknown[] = []) => ({
  db: {
    select: jest.fn()
      .mockReturnValueOnce(dbChain(interviewRow ? [interviewRow] : []))
      .mockReturnValueOnce(dbChain(msgRows)),
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
  },
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ProcessAnswerUseCase', () => {
  const INTERVIEW_ID = 'interview-001';
  const USER_ID = 'user-abc';

  let aiService: ReturnType<typeof makeAiService>;
  let ttsService: ReturnType<typeof makeTtsService>;

  const makeRedisHit = () => makeRedisService(makeInterviewJson(USER_ID));

  beforeEach(() => {
    aiService = makeAiService();
    ttsService = makeTtsService();
  });

  const makeSut = (
    redis: ReturnType<typeof makeRedisService>,
    drizzle = makeDrizzleService(),
  ) =>
    new ProcessAnswerUseCase(aiService as any, ttsService as any, redis as any, drizzle as any);

  // ── Happy path ───────────────────────────────────────────────────────────────

  it('evaluates the answer and returns the AI response', async () => {
    const sut = makeSut(makeRedisHit());
    const result = await sut.execute({ interviewId: INTERVIEW_ID, answer: 'My answer', userId: USER_ID });

    expect(result.aiResponse).toBe('Good answer! Here is my feedback.');
    expect(aiService.evaluateAnswer).toHaveBeenCalledTimes(1);
  });

  it('generates the next question when interview is not complete', async () => {
    const sut = makeSut(makeRedisHit());
    const result = await sut.execute({ interviewId: INTERVIEW_ID, answer: 'My answer', userId: USER_ID });

    expect(result.isComplete).toBe(false);
    expect(result.nextQuestion).toBe('Next question?');
    expect(aiService.generateQuestion).toHaveBeenCalledTimes(1);
  });

  it('saves updated interview state back to Redis', async () => {
    const redis = makeRedisHit();
    const sut = makeSut(redis);
    await sut.execute({ interviewId: INTERVIEW_ID, answer: 'My answer', userId: USER_ID });

    expect(redis.set).toHaveBeenCalledWith(
      expect.stringMatching(/^interview:/),
      expect.any(String),
      3600,
    );
  });

  it('includes audioBase64 when TTS succeeds', async () => {
    const sut = makeSut(makeRedisHit());
    const result = await sut.execute({ interviewId: INTERVIEW_ID, answer: 'ok', userId: USER_ID });

    expect(result.audioBase64).toBe(Buffer.from('audio').toString('base64'));
  });

  it('returns null audioBase64 when TTS fails (best-effort)', async () => {
    ttsService.synthesize.mockRejectedValue(new Error('TTS down'));
    const sut = makeSut(makeRedisHit());
    const result = await sut.execute({ interviewId: INTERVIEW_ID, answer: 'ok', userId: USER_ID });

    expect(result.audioBase64).toBeNull();
  });

  // ── isComplete logic ─────────────────────────────────────────────────────────

  it('marks isComplete when interviewer messages reach maxQuestions', async () => {
    // Interview with 9 interviewer messages already; after evaluateAnswer adds 1 more → 10 = maxQuestions
    const raw = makeInterviewJson(USER_ID, 9);
    const redis = makeRedisService(raw);
    const sut = makeSut(redis);

    const result = await sut.execute({ interviewId: INTERVIEW_ID, answer: 'last answer', userId: USER_ID });

    expect(result.isComplete).toBe(true);
    expect(result.nextQuestion).toBeNull();
    expect(aiService.generateQuestion).not.toHaveBeenCalled();
  });

  // ── Vision metrics ───────────────────────────────────────────────────────────

  it('adds vision metrics to the interview when provided', async () => {
    const metrics = { eye_contact: 0.8, stress_level: 0.2, confidence: 0.9 };
    const redis = makeRedisHit();
    const sut = makeSut(redis);

    const result = await sut.execute({
      interviewId: INTERVIEW_ID,
      answer: 'ok',
      userId: USER_ID,
      visionMetrics: metrics,
    });

    // Vision metrics get serialised back into Redis — verify the state object includes them
    const savedJson = JSON.parse((redis.set as jest.Mock).mock.calls[0][1] as string) as {
      visionMetrics: unknown[];
    };
    expect(savedJson.visionMetrics).toHaveLength(1);
    expect(result.aiResponse).toBeTruthy();
  });

  // ── Ownership check ──────────────────────────────────────────────────────────

  it('throws ForbiddenException when userId does not match interview owner', async () => {
    const redis = makeRedisService(makeInterviewJson('owner-xyz'));
    const sut = makeSut(redis);

    await expect(
      sut.execute({ interviewId: INTERVIEW_ID, answer: 'ok', userId: 'attacker-999' }),
    ).rejects.toThrow(ForbiddenException);
  });

  // ── Redis miss → DB fallback ─────────────────────────────────────────────────

  it('reconstructs interview from DB when Redis cache is empty', async () => {
    const dbRow = {
      id: INTERVIEW_ID,
      userId: USER_ID,
      candidateName: 'John',
      role: 'Engineer',
      language: 'en',
      experienceLevel: 'mid',
      status: 'in_progress',
      sessionVariant: 1,
      maxQuestions: 10,
      createdAt: new Date(),
    };
    const dbMessages = [
      { role: 'interviewer', content: 'Q1', interviewId: INTERVIEW_ID, createdAt: new Date() },
    ];
    const redis = makeRedisService(null); // cache miss
    const drizzle = makeDrizzleService(dbRow, dbMessages);
    const sut = makeSut(redis, drizzle);

    const result = await sut.execute({ interviewId: INTERVIEW_ID, answer: 'ok', userId: USER_ID });

    expect(drizzle.db.select).toHaveBeenCalledTimes(2); // interviews + messages
    expect(result.aiResponse).toBeTruthy();
  });

  it('throws NotFoundException when interview not in Redis or DB', async () => {
    const redis = makeRedisService(null);
    const drizzle = makeDrizzleService(undefined, []); // empty DB rows
    const sut = makeSut(redis, drizzle);

    await expect(
      sut.execute({ interviewId: 'ghost-id', answer: 'ok', userId: USER_ID }),
    ).rejects.toThrow(NotFoundException);
  });
});
