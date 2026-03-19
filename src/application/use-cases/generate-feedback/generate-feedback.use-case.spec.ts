import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { GenerateFeedbackUseCase } from './generate-feedback.use-case';
import { Interview, InterviewFeedback } from '../../../domain/entities/interview.entity';

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

function makeInterviewJson(userId: string): string {
  const interview = new Interview('John', 'Engineer', 'en', 'mid', userId, 10);
  interview.start();
  interview.addMessage('interviewer', 'Tell me about yourself');
  interview.addMessage('candidate', 'I am a developer');
  return JSON.stringify(interview);
}

const makeFeedback = (): InterviewFeedback => ({
  technical: 8,
  communication: 7,
  confidence: 8,
  clarity: 9,
  overall: 8,
  summary: 'Great performance',
  strengths: ['Problem solving'],
  improvements: ['Communication'],
});

const makeAiService = () => ({
  generateFeedback: jest.fn().mockResolvedValue(makeFeedback()),
  generateQuestion: jest.fn(),
  evaluateAnswer: jest.fn(),
});

const makeRedisService = (raw: string | null = null) => ({
  set: jest.fn().mockResolvedValue(undefined),
  get: jest.fn().mockResolvedValue(raw),
  del: jest.fn().mockResolvedValue(undefined),
  exists: jest.fn().mockResolvedValue(false),
});

const makeMailService = () => ({
  sendInterviewFeedback: jest.fn().mockResolvedValue(undefined),
});

interface FakeTx {
  update: jest.Mock;
  insert: jest.Mock;
}

const makeTxChain = (): FakeTx => ({
  update: jest.fn().mockReturnValue({
    set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
  }),
  insert: jest.fn().mockReturnValue({
    values: jest.fn().mockReturnValue({ onConflictDoNothing: jest.fn().mockResolvedValue([]) }),
  }),
});

const makeDrizzleService = (
  interviewRow?: Record<string, unknown>,
  msgRows: unknown[] = [],
  userRows: unknown[] = [{ email: 'john@test.com', name: 'John' }],
) => {
  const tx = makeTxChain();
  return {
    db: {
      select: jest.fn()
        .mockReturnValueOnce(dbChain(interviewRow ? [interviewRow] : []))
        .mockReturnValueOnce(dbChain(msgRows))
        .mockReturnValueOnce(dbChain(userRows)), // for sendFeedbackEmail
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
      transaction: jest.fn().mockImplementation(
        async (fn: (tx: FakeTx) => Promise<void>) => fn(tx),
      ),
    },
    _tx: tx,
  };
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe('GenerateFeedbackUseCase', () => {
  const INTERVIEW_ID = 'interview-001';
  const USER_ID = 'user-abc';

  let aiService: ReturnType<typeof makeAiService>;
  let mailService: ReturnType<typeof makeMailService>;

  const makeRedisHit = () => makeRedisService(makeInterviewJson(USER_ID));

  beforeEach(() => {
    aiService = makeAiService();
    mailService = makeMailService();
  });

  const makeSut = (
    redis: ReturnType<typeof makeRedisService>,
    drizzle = makeDrizzleService(),
  ) =>
    new GenerateFeedbackUseCase(
      aiService as any,
      redis as any,
      drizzle as any,
      mailService as any,
    );

  // ── Happy path ───────────────────────────────────────────────────────────────

  it('generates feedback and returns the InterviewFeedback object', async () => {
    const sut = makeSut(makeRedisHit());
    const result = await sut.execute({ interviewId: INTERVIEW_ID, userId: USER_ID });

    expect(result).toMatchObject({
      technical: 8,
      communication: 7,
      overall: 8,
      summary: 'Great performance',
    });
  });

  it('calls aiService.generateFeedback with context derived from the interview', async () => {
    const sut = makeSut(makeRedisHit());
    await sut.execute({ interviewId: INTERVIEW_ID, userId: USER_ID });

    expect(aiService.generateFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'Engineer',
        candidateName: 'John',
        experienceLevel: 'mid',
        language: 'en',
      }),
    );
  });

  it('persists feedback in a DB transaction', async () => {
    const drizzle = makeDrizzleService();
    const sut = makeSut(makeRedisHit(), drizzle);
    await sut.execute({ interviewId: INTERVIEW_ID, userId: USER_ID });

    expect(drizzle.db.transaction).toHaveBeenCalledTimes(1);
    // Feedback insert must be part of the transaction
    expect(drizzle._tx.insert).toHaveBeenCalled();
    expect(drizzle._tx.update).toHaveBeenCalled();
  });

  it('updates Redis with completed state (24h TTL)', async () => {
    const redis = makeRedisHit();
    const sut = makeSut(redis);
    await sut.execute({ interviewId: INTERVIEW_ID, userId: USER_ID });

    expect(redis.set).toHaveBeenCalledWith(
      expect.stringMatching(/^interview:/),
      expect.any(String),
      86400,
    );
  });

  // ── Ownership check ──────────────────────────────────────────────────────────

  it('throws ForbiddenException when userId does not match interview owner', async () => {
    const sut = makeSut(makeRedisHit());

    await expect(
      sut.execute({ interviewId: INTERVIEW_ID, userId: 'attacker-999' }),
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
    const redis = makeRedisService(null);
    const drizzle = makeDrizzleService(dbRow, dbMessages);
    const sut = makeSut(redis, drizzle);

    const result = await sut.execute({ interviewId: INTERVIEW_ID, userId: USER_ID });
    expect(result.overall).toBe(8);
  });

  it('throws NotFoundException when interview not found in Redis or DB', async () => {
    const redis = makeRedisService(null);
    const drizzle = makeDrizzleService(undefined, []);
    const sut = makeSut(redis, drizzle);

    await expect(
      sut.execute({ interviewId: 'ghost-id', userId: USER_ID }),
    ).rejects.toThrow(NotFoundException);
  });

  // ── Email (best-effort) ──────────────────────────────────────────────────────

  it('sends feedback email after persisting (fire-and-forget, no throw on failure)', async () => {
    mailService.sendInterviewFeedback.mockRejectedValue(new Error('SMTP error'));
    const sut = makeSut(makeRedisHit());

    // Should not throw even if mail fails
    await expect(
      sut.execute({ interviewId: INTERVIEW_ID, userId: USER_ID }),
    ).resolves.toBeDefined();
  });
});
