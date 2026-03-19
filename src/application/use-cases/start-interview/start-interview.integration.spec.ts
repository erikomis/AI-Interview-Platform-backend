/**
 * End-to-end integration test for StartInterviewUseCase.
 * Spins up real PostgreSQL + Redis containers via Testcontainers.
 * Requires Docker running.  Run with: npm run test:integration
 */
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import postgres from 'postgres';
import { drizzle, PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import Redis from 'ioredis';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import * as schema from '../../../infrastructure/database/schema';
import { StartInterviewUseCase } from './start-interview.use-case';
import { Interview } from '../../../domain/entities/interview.entity';

// ── Fake services ─────────────────────────────────────────────────────────────

const makeAiService = () => ({
  generateQuestion: jest.fn().mockResolvedValue('Tell me about your experience with TypeScript'),
  evaluateAnswer: jest.fn(),
  generateFeedback: jest.fn(),
});

const makeTtsService = () => ({
  synthesize: jest.fn().mockResolvedValue(null), // TTS optional
});

// ── Drizzle/Redis adapters that wrap real clients ─────────────────────────────

function makeDrizzleService(db: PostgresJsDatabase<typeof schema>): { db: typeof db } {
  return { db };
}

function makeRedisService(client: Redis) {
  return {
    set: async (key: string, value: string, ttlSeconds?: number) => {
      if (ttlSeconds) await client.set(key, value, 'EX', ttlSeconds);
      else await client.set(key, value);
    },
    get: (key: string) => client.get(key),
    del: (key: string) => client.del(key),
    exists: async (key: string) => (await client.exists(key)) === 1,
  };
}

// ── Schema helpers ────────────────────────────────────────────────────────────

async function createSchema(sql: postgres.Sql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id              UUID PRIMARY KEY,
      name            TEXT NOT NULL,
      email           TEXT NOT NULL UNIQUE,
      password_hash   TEXT NOT NULL,
      email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
      cv_summary      TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS interviews (
      id               UUID PRIMARY KEY,
      user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role             TEXT NOT NULL,
      language         TEXT NOT NULL DEFAULT 'pt',
      experience_level TEXT NOT NULL DEFAULT 'mid',
      status           TEXT NOT NULL DEFAULT 'pending',
      session_variant  INTEGER NOT NULL DEFAULT 1,
      max_questions    INTEGER NOT NULL DEFAULT 10,
      candidate_name   TEXT,
      topics_covered   JSONB,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at     TIMESTAMPTZ
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS messages (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      interview_id UUID NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
      role         TEXT NOT NULL,
      content      TEXT NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS feedback (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      interview_id   UUID NOT NULL UNIQUE REFERENCES interviews(id) ON DELETE CASCADE,
      technical      REAL NOT NULL,
      communication  REAL NOT NULL,
      confidence     REAL NOT NULL,
      clarity        REAL NOT NULL,
      overall        REAL NOT NULL,
      summary        TEXT NOT NULL,
      strengths      JSONB NOT NULL,
      improvements   JSONB NOT NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('StartInterviewUseCase — full integration', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedTestContainer;
  let sql: postgres.Sql;
  let db: PostgresJsDatabase<typeof schema>;
  let redisClient: Redis;
  let sut: StartInterviewUseCase;
  let aiService: ReturnType<typeof makeAiService>;
  let userId: string;

  beforeAll(async () => {
    // Start containers in parallel
    [pgContainer, redisContainer] = await Promise.all([
      new PostgreSqlContainer('postgres:16-alpine')
        .withDatabase('test_interviews')
        .withUsername('test')
        .withPassword('test')
        .start(),
      new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
    ]);

    sql = postgres(pgContainer.getConnectionUri(), { max: 5 });
    db = drizzle(sql, { schema });
    await createSchema(sql);

    redisClient = new Redis({
      host: redisContainer.getHost(),
      port: redisContainer.getMappedPort(6379),
    });

    aiService = makeAiService();
    sut = new StartInterviewUseCase(
      aiService as any,
      makeTtsService() as any,
      makeRedisService(redisClient) as any,
      makeDrizzleService(db) as any,
    );

    // Seed a real user to satisfy FK constraint
    userId = uuidv4();
    await db.insert(schema.users).values({
      id: userId,
      name: 'Integration User',
      email: `integration-${userId}@test.com`,
      passwordHash: 'hashed',
    });
  }, 120_000);

  afterAll(async () => {
    await redisClient.quit();
    await sql.end();
    await pgContainer.stop();
    await redisContainer.stop();
  });

  afterEach(async () => {
    await redisClient.flushdb();
  });

  // ── Tests ─────────────────────────────────────────────────────────────────

  it('creates an interview, persists to DB and caches in Redis', async () => {
    const result = await sut.execute({
      candidateId: 'Jane Smith',
      role: 'Backend Engineer',
      language: 'en',
      experienceLevel: 'mid',
      userId,
      sessionMode: 'full',
    });

    expect(result.interview).toBeInstanceOf(Interview);
    expect(result.firstQuestion).toBe('Tell me about your experience with TypeScript');

    // DB: interview row must exist
    const [dbRow] = await db
      .select()
      .from(schema.interviews)
      .where(eq(schema.interviews.id, result.interview.id));

    expect(dbRow).toBeDefined();
    expect(dbRow.role).toBe('Backend Engineer');
    expect(dbRow.userId).toBe(userId);
    expect(dbRow.maxQuestions).toBe(10);
    expect(dbRow.candidateName).toBe('Jane Smith');
    expect(dbRow.status).toBe('in_progress');

    // Redis: interview state must be cached
    const cached = await redisClient.get(`interview:${result.interview.id}`);
    expect(cached).not.toBeNull();
    const parsed = JSON.parse(cached!) as { candidateId: string; role: string };
    expect(parsed.candidateId).toBe('Jane Smith');
    expect(parsed.role).toBe('Backend Engineer');
  });

  it('sets correct maxQuestions for practice mode (5)', async () => {
    const result = await sut.execute({
      candidateId: 'Junior Dev',
      role: 'Frontend',
      language: 'en',
      experienceLevel: 'junior',
      userId,
      sessionMode: 'practice',
    });

    expect(result.interview.maxQuestions).toBe(5);

    const [dbRow] = await db
      .select()
      .from(schema.interviews)
      .where(eq(schema.interviews.id, result.interview.id));
    expect(dbRow.maxQuestions).toBe(5);
  });

  it('sets correct maxQuestions for intensive mode (15)', async () => {
    const result = await sut.execute({
      candidateId: 'Senior Dev',
      role: 'Staff Engineer',
      language: 'en',
      experienceLevel: 'senior',
      userId,
      sessionMode: 'intensive',
    });

    expect(result.interview.maxQuestions).toBe(15);
  });

  it('passes previousTopics from prior sessions to the AI', async () => {
    // Create a completed interview with topics covered
    const prevId = uuidv4();
    await db.insert(schema.interviews).values({
      id: prevId,
      userId,
      role: 'Backend',
      language: 'en',
      experienceLevel: 'mid',
      status: 'completed',
      sessionVariant: 1,
      maxQuestions: 10,
      topicsCovered: ['mid-variant1'],
      completedAt: new Date(),
    });

    await sut.execute({
      candidateId: 'Alice',
      role: 'Backend',
      language: 'en',
      experienceLevel: 'mid',
      userId,
      sessionMode: 'full',
    });

    expect(aiService.generateQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        previousTopics: expect.arrayContaining(['mid-variant1']),
      }),
    );
  });

  it('stores CV summary as cvContext in AI call', async () => {
    await sut.execute({
      candidateId: 'Bob',
      role: 'DevOps',
      language: 'en',
      experienceLevel: 'senior',
      userId,
      sessionMode: 'full',
      cvSummary: '10 years Kubernetes, Terraform expert',
    });

    expect(aiService.generateQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ cvContext: '10 years Kubernetes, Terraform expert' }),
    );
  });

  it('interview in Redis is a valid JSON Interview object', async () => {
    const result = await sut.execute({
      candidateId: 'Carol',
      role: 'Data Engineer',
      language: 'pt',
      experienceLevel: 'junior',
      userId,
      sessionMode: 'full',
    });

    const cached = await redisClient.get(`interview:${result.interview.id}`);
    const parsed = JSON.parse(cached!) as Record<string, unknown>;

    // Must be restoreable via fromJSON
    const restored = Interview.fromJSON(parsed);
    expect(restored.id).toBe(result.interview.id);
    expect(restored.messages).toHaveLength(1); // first question added
    expect(restored.messages[0].role).toBe('interviewer');
  });
});
