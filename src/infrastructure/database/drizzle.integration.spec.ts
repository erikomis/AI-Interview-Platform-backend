/**
 * Integration tests for DrizzleService against a real PostgreSQL container.
 * Requires Docker running.  Run with: npm run test:integration
 */
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { drizzle, PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import * as schema from './schema';

// ── Helpers ──────────────────────────────────────────────────────────────────

type Schema = typeof schema;

async function createTables(sql: postgres.Sql): Promise<void> {
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

function makeDb(connectionUri: string): { sql: postgres.Sql; db: PostgresJsDatabase<Schema> } {
  const sql = postgres(connectionUri, { max: 5 });
  const db = drizzle(sql, { schema });
  return { sql, db };
}

// ── Test setup ───────────────────────────────────────────────────────────────

describe('DrizzleService — PostgreSQL integration', () => {
  let container: StartedPostgreSqlContainer;
  let sql: postgres.Sql;
  let db: PostgresJsDatabase<Schema>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('test_interviews')
      .withUsername('test')
      .withPassword('test')
      .start();

    ({ sql, db } = makeDb(container.getConnectionUri()));
    await createTables(sql);
  }, 120_000);

  afterAll(async () => {
    await sql.end();
    await container.stop();
  });

  // ── Users ─────────────────────────────────────────────────────────────────

  describe('users table', () => {
    it('inserts and retrieves a user', async () => {
      const id = uuidv4();
      await db.insert(schema.users).values({
        id,
        name: 'Alice',
        email: `alice-${id}@test.com`,
        passwordHash: 'hashed',
        emailVerified: false,
      });

      const rows = await db.select().from(schema.users).where(eq(schema.users.id, id));
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('Alice');
    });

    it('enforces unique email constraint', async () => {
      const email = `dup-${uuidv4()}@test.com`;
      await db.insert(schema.users).values({ id: uuidv4(), name: 'U1', email, passwordHash: 'h' });

      await expect(
        db.insert(schema.users).values({ id: uuidv4(), name: 'U2', email, passwordHash: 'h' }),
      ).rejects.toThrow();
    });

    it('stores and retrieves cvSummary', async () => {
      const id = uuidv4();
      await db.insert(schema.users).values({
        id,
        name: 'Bob',
        email: `bob-${id}@test.com`,
        passwordHash: 'h',
        cvSummary: 'Senior engineer with 10 years experience',
      });

      const [user] = await db.select().from(schema.users).where(eq(schema.users.id, id));
      expect(user.cvSummary).toBe('Senior engineer with 10 years experience');
    });

    it('cascades delete to child records', async () => {
      const userId = uuidv4();
      await db.insert(schema.users).values({
        id: userId,
        name: 'ToDelete',
        email: `del-${userId}@test.com`,
        passwordHash: 'h',
      });
      const interviewId = uuidv4();
      await db.insert(schema.interviews).values({
        id: interviewId,
        userId,
        role: 'Dev',
        language: 'en',
        experienceLevel: 'mid',
        status: 'in_progress',
        sessionVariant: 1,
        maxQuestions: 10,
      });

      // Delete user → interview should cascade
      await db.delete(schema.users).where(eq(schema.users.id, userId));

      const interviews = await db
        .select()
        .from(schema.interviews)
        .where(eq(schema.interviews.id, interviewId));
      expect(interviews).toHaveLength(0);
    });
  });

  // ── Interviews ────────────────────────────────────────────────────────────

  describe('interviews table', () => {
    let userId: string;

    beforeAll(async () => {
      userId = uuidv4();
      await db.insert(schema.users).values({
        id: userId,
        name: 'Interviewer User',
        email: `interviewuser-${userId}@test.com`,
        passwordHash: 'h',
      });
    });

    it('inserts an interview and retrieves it by id', async () => {
      const id = uuidv4();
      await db.insert(schema.interviews).values({
        id,
        userId,
        role: 'Software Engineer',
        language: 'en',
        experienceLevel: 'senior',
        status: 'in_progress',
        sessionVariant: 2,
        maxQuestions: 15,
        candidateName: 'John Doe',
      });

      const [row] = await db
        .select()
        .from(schema.interviews)
        .where(eq(schema.interviews.id, id));

      expect(row.role).toBe('Software Engineer');
      expect(row.experienceLevel).toBe('senior');
      expect(row.maxQuestions).toBe(15);
      expect(row.candidateName).toBe('John Doe');
    });

    it('stores and retrieves topicsCovered as JSONB', async () => {
      const id = uuidv4();
      const topics = ['mid-variant1', 'mid-variant2'];
      await db.insert(schema.interviews).values({
        id,
        userId,
        role: 'Dev',
        language: 'pt',
        experienceLevel: 'mid',
        status: 'completed',
        sessionVariant: 1,
        maxQuestions: 10,
        topicsCovered: topics,
        completedAt: new Date(),
      });

      const [row] = await db
        .select()
        .from(schema.interviews)
        .where(eq(schema.interviews.id, id));
      expect(row.topicsCovered).toEqual(topics);
    });
  });

  // ── Messages ──────────────────────────────────────────────────────────────

  describe('messages table', () => {
    let userId: string;
    let interviewId: string;

    beforeAll(async () => {
      userId = uuidv4();
      await db.insert(schema.users).values({
        id: userId,
        name: 'Msg User',
        email: `msguser-${userId}@test.com`,
        passwordHash: 'h',
      });
      interviewId = uuidv4();
      await db.insert(schema.interviews).values({
        id: interviewId,
        userId,
        role: 'QA',
        language: 'pt',
        experienceLevel: 'junior',
        status: 'in_progress',
        sessionVariant: 1,
        maxQuestions: 5,
      });
    });

    it('inserts and retrieves messages in order', async () => {
      await db.insert(schema.messages).values([
        { interviewId, role: 'interviewer', content: 'Q1' },
        { interviewId, role: 'candidate', content: 'A1' },
        { interviewId, role: 'interviewer', content: 'Q2' },
      ]);

      const rows = await db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.interviewId, interviewId));

      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.role)).toEqual(['interviewer', 'candidate', 'interviewer']);
    });
  });

  // ── Feedback ──────────────────────────────────────────────────────────────

  describe('feedback table', () => {
    let userId: string;
    let interviewId: string;

    beforeAll(async () => {
      userId = uuidv4();
      await db.insert(schema.users).values({
        id: userId,
        name: 'Fb User',
        email: `fbuser-${userId}@test.com`,
        passwordHash: 'h',
      });
      interviewId = uuidv4();
      await db.insert(schema.interviews).values({
        id: interviewId,
        userId,
        role: 'Backend Dev',
        language: 'en',
        experienceLevel: 'senior',
        status: 'in_progress',
        sessionVariant: 3,
        maxQuestions: 10,
      });
    });

    it('inserts feedback and retrieves all scores', async () => {
      await db.insert(schema.feedback).values({
        interviewId,
        technical: 8.5,
        communication: 7.0,
        confidence: 9.0,
        clarity: 8.0,
        overall: 8.1,
        summary: 'Excellent candidate',
        strengths: ['algorithms', 'system design'],
        improvements: ['communication'],
      });

      const [row] = await db
        .select()
        .from(schema.feedback)
        .where(eq(schema.feedback.interviewId, interviewId));

      expect(row.technical).toBeCloseTo(8.5);
      expect(row.overall).toBeCloseTo(8.1);
      expect(row.strengths).toEqual(['algorithms', 'system design']);
      expect(row.improvements).toEqual(['communication']);
    });

    it('enforces unique constraint on interviewId (one feedback per interview)', async () => {
      await expect(
        db.insert(schema.feedback).values({
          interviewId,
          technical: 5,
          communication: 5,
          confidence: 5,
          clarity: 5,
          overall: 5,
          summary: 'Duplicate',
          strengths: [],
          improvements: [],
        }),
      ).rejects.toThrow();
    });
  });

  // ── Full interview lifecycle ───────────────────────────────────────────────

  describe('full interview lifecycle', () => {
    it('persists user → interview → messages → feedback atomically', async () => {
      const userId = uuidv4();
      const interviewId = uuidv4();

      // 1. Create user
      await db.insert(schema.users).values({
        id: userId,
        name: 'Full Flow',
        email: `flow-${userId}@test.com`,
        passwordHash: 'h',
      });

      // 2. Create interview
      await db.insert(schema.interviews).values({
        id: interviewId,
        userId,
        role: 'Fullstack Dev',
        language: 'en',
        experienceLevel: 'mid',
        status: 'in_progress',
        sessionVariant: 2,
        maxQuestions: 10,
        candidateName: 'Full Flow',
      });

      // 3. Insert messages
      await db.insert(schema.messages).values([
        { interviewId, role: 'interviewer', content: 'What is your stack?' },
        { interviewId, role: 'candidate', content: 'React, Node, Postgres' },
      ]);

      // 4. Transaction: complete interview + insert feedback
      await db.transaction(async (tx) => {
        await tx
          .update(schema.interviews)
          .set({ status: 'completed', completedAt: new Date(), topicsCovered: ['mid-variant2'] })
          .where(eq(schema.interviews.id, interviewId));

        await tx
          .insert(schema.feedback)
          .values({
            interviewId,
            technical: 8,
            communication: 7,
            confidence: 8,
            clarity: 9,
            overall: 8,
            summary: 'Good candidate',
            strengths: ['fullstack'],
            improvements: ['depth'],
          })
          .onConflictDoNothing();
      });

      // 5. Verify final state
      const [interview] = await db
        .select()
        .from(schema.interviews)
        .where(eq(schema.interviews.id, interviewId));
      const [fb] = await db
        .select()
        .from(schema.feedback)
        .where(eq(schema.feedback.interviewId, interviewId));
      const msgs = await db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.interviewId, interviewId));

      expect(interview.status).toBe('completed');
      expect(interview.topicsCovered).toEqual(['mid-variant2']);
      expect(fb.overall).toBeCloseTo(8);
      expect(msgs).toHaveLength(2);
    });
  });
});
