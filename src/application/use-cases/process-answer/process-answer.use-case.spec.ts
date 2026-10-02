import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ProcessAnswerUseCase } from './process-answer.use-case';
import { Interview } from '../../../domain/entities/interview.entity';
import {
  AllQuestionsAnsweredException,
  InterviewBusyException,
  InterviewNotInProgressException,
} from '../../errors/interview.errors';

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
function makeInterviewJson(userId: string, interviewerMessages = 1, interviewer: 'male' | 'female' = 'male'): string {
  const interview = new Interview('John', 'Engineer', 'en', 'mid', userId, 10, interviewer);
  interview.start();
  // Realistic history: every question except the current one has been answered.
  for (let i = 0; i < interviewerMessages; i++) {
    if (i > 0) interview.addMessage('candidate', `Answer ${i}`);
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
  setNx: jest.fn().mockResolvedValue(true),
  set: jest.fn().mockResolvedValue(undefined),
  get: jest.fn().mockResolvedValue(raw),
  del: jest.fn().mockResolvedValue(undefined),
  exists: jest.fn().mockResolvedValue(false),
});

const makeDrizzleService = (interviewRow?: Record<string, unknown>, msgRows: unknown[] = []) => {
  const insertValues = jest.fn().mockResolvedValue([]);
  return {
    db: {
      select: jest.fn()
        .mockReturnValueOnce(dbChain(interviewRow ? [interviewRow] : []))
        .mockReturnValueOnce(dbChain(msgRows)),
      insert: jest.fn().mockReturnValue({ values: insertValues }),
    },
    _insertValues: insertValues,
  };
};

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
    expect(result.responseAudioBase64).toBeNull();
  });

  it('voices the evaluation as well as the next question', async () => {
    ttsService.synthesize.mockImplementation(async (text: string) => Buffer.from(`voice:${text}`));
    const sut = makeSut(makeRedisHit());
    const result = await sut.execute({ interviewId: INTERVIEW_ID, answer: 'ok', userId: USER_ID });

    expect(Buffer.from(result.responseAudioBase64!, 'base64').toString()).toBe(`voice:${result.aiResponse}`);
    expect(Buffer.from(result.audioBase64!, 'base64').toString()).toBe(`voice:${result.nextQuestion}`);
  });

  // ── isComplete logic ─────────────────────────────────────────────────────────

  it('marks isComplete when the candidate answers the last question', async () => {
    // 10 questions asked, 9 answered; this answer is the 10th → reaches maxQuestions
    const raw = makeInterviewJson(USER_ID, 10);
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
      interviewer: 'female',
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
    // DB status 'in_progress' maps to the domain enum and the last interviewer
    // message becomes the question being answered
    expect(aiService.evaluateAnswer).toHaveBeenCalledWith(expect.objectContaining({ question: 'Q1' }));
    // The persona survives the Redis → Postgres fallback
    expect(aiService.evaluateAnswer).toHaveBeenCalledWith(expect.objectContaining({ interviewer: 'female' }));
  });

  it('threads the interviewer persona to the AI and the TTS voice', async () => {
    const sut = makeSut(makeRedisService(makeInterviewJson(USER_ID, 1, 'female')));
    await sut.execute({ interviewId: INTERVIEW_ID, answer: 'My answer', userId: USER_ID });

    expect(aiService.evaluateAnswer).toHaveBeenCalledWith(expect.objectContaining({ interviewer: 'female' }));
    expect(aiService.generateQuestion).toHaveBeenCalledWith(expect.objectContaining({ interviewer: 'female' }));
    expect(ttsService.synthesize).toHaveBeenCalledTimes(2);
    for (const call of ttsService.synthesize.mock.calls) {
      expect(call.slice(1)).toEqual(['en', 'female']);
    }
  });

  it('rejects answers once the DB says the interview is completed', async () => {
    const dbRow = {
      id: INTERVIEW_ID, userId: USER_ID, candidateName: 'John', role: 'Engineer', language: 'en',
      experienceLevel: 'mid', status: 'completed', sessionVariant: 1, maxQuestions: 10, createdAt: new Date(),
    };
    const sut = makeSut(makeRedisService(null), makeDrizzleService(dbRow, []));

    await expect(
      sut.execute({ interviewId: INTERVIEW_ID, answer: 'ok', userId: USER_ID }),
    ).rejects.toThrow(BadRequestException);
    expect(aiService.evaluateAnswer).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when interview not in Redis or DB', async () => {
    const redis = makeRedisService(null);
    const drizzle = makeDrizzleService(undefined, []); // empty DB rows
    const sut = makeSut(redis, drizzle);

    await expect(
      sut.execute({ interviewId: 'ghost-id', answer: 'ok', userId: USER_ID }),
    ).rejects.toThrow(NotFoundException);
  });

  // ── Incremental persistence ──────────────────────────────────────────────────

  it('persists answer, evaluation and next question to Postgres in order', async () => {
    const drizzle = makeDrizzleService();
    const sut = makeSut(makeRedisHit(), drizzle);
    await sut.execute({ interviewId: INTERVIEW_ID, answer: 'My answer', userId: USER_ID });

    const rows = drizzle._insertValues.mock.calls[0][0] as Array<{ role: string; content: string; createdAt: Date }>;
    expect(rows.map((r) => [r.role, r.content])).toEqual([
      ['candidate', 'My answer'],
      ['interviewer', 'Good answer! Here is my feedback.'],
      ['interviewer', 'Next question?'],
    ]);
    // Strictly increasing timestamps keep ORDER BY created_at stable
    expect(rows[1].createdAt.getTime()).toBeGreaterThan(rows[0].createdAt.getTime());
    expect(rows[2].createdAt.getTime()).toBeGreaterThan(rows[1].createdAt.getTime());
  });

  it('persists only answer + evaluation on the final question', async () => {
    const drizzle = makeDrizzleService();
    const sut = makeSut(makeRedisService(makeInterviewJson(USER_ID, 10)), drizzle);
    await sut.execute({ interviewId: INTERVIEW_ID, answer: 'last', userId: USER_ID });

    expect(drizzle._insertValues.mock.calls[0][0]).toHaveLength(2);
  });

  // ── Concurrency / state guards ───────────────────────────────────────────────

  it('throws ConflictException when another answer holds the interview lock', async () => {
    const redis = makeRedisHit();
    redis.setNx.mockResolvedValue(false);
    const sut = makeSut(redis);

    await expect(
      sut.execute({ interviewId: INTERVIEW_ID, answer: 'ok', userId: USER_ID }),
    ).rejects.toThrow(ConflictException);
    await expect(
      sut.execute({ interviewId: INTERVIEW_ID, answer: 'ok', userId: USER_ID }),
    ).rejects.toBeInstanceOf(InterviewBusyException);
    expect(aiService.evaluateAnswer).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
  });

  it('acquires lock:interview:<id> and releases it even when processing fails', async () => {
    aiService.evaluateAnswer.mockRejectedValue(new Error('LLM down'));
    const redis = makeRedisHit();
    const sut = makeSut(redis);

    await expect(
      sut.execute({ interviewId: INTERVIEW_ID, answer: 'ok', userId: USER_ID }),
    ).rejects.toThrow('LLM down');
    expect(redis.setNx).toHaveBeenCalledWith(`lock:interview:${INTERVIEW_ID}`, expect.any(String), expect.any(Number));
    expect(redis.del).toHaveBeenCalledWith(`lock:interview:${INTERVIEW_ID}`);
  });

  it('rejects answers when the interview is not in progress', async () => {
    const interview = Interview.fromJSON(JSON.parse(makeInterviewJson(USER_ID)) as Record<string, unknown>);
    interview.complete({
      technical: 5, communication: 5, confidence: 5, clarity: 5, overall: 5,
      summary: '', strengths: [], improvements: [],
    });
    const sut = makeSut(makeRedisService(JSON.stringify(interview)));

    await expect(
      sut.execute({ interviewId: INTERVIEW_ID, answer: 'ok', userId: USER_ID }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      sut.execute({ interviewId: INTERVIEW_ID, answer: 'ok', userId: USER_ID }),
    ).rejects.toBeInstanceOf(InterviewNotInProgressException);
  });

  it('rejects extra answers once every question has been answered', async () => {
    const interview = Interview.fromJSON(JSON.parse(makeInterviewJson(USER_ID, 10)) as Record<string, unknown>);
    interview.addMessage('candidate', 'Answer 10');
    const sut = makeSut(makeRedisService(JSON.stringify(interview)));

    await expect(
      sut.execute({ interviewId: INTERVIEW_ID, answer: 'one more', userId: USER_ID }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      sut.execute({ interviewId: INTERVIEW_ID, answer: 'one more', userId: USER_ID }),
    ).rejects.toBeInstanceOf(AllQuestionsAnsweredException);
  });

  it('passes maxQuestions to the question generator', async () => {
    const sut = makeSut(makeRedisHit());
    await sut.execute({ interviewId: INTERVIEW_ID, answer: 'ok', userId: USER_ID });

    expect(aiService.generateQuestion).toHaveBeenCalledWith(expect.objectContaining({ maxQuestions: 10 }));
  });
});
