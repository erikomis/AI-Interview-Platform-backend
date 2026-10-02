import { NotFoundException } from '@nestjs/common';
import { eq, asc } from 'drizzle-orm';
import { Interview, InterviewFeedback } from '../../domain/entities/interview.entity';
import { InterviewStatus } from '../../domain/value-objects/interview-status.vo';
import { RedisService } from '../../infrastructure/database/redis.service';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import { interviews, messages, feedback } from '../../infrastructure/database/schema';

// ─── Shared interview persistence helpers ────────────────────────────────────
// Redis holds the live session (1h TTL); PostgreSQL is the durable copy.
// Messages are written to Postgres incrementally, so a session can always be
// rebuilt from the DB once the Redis key has expired.

export const INTERVIEW_CACHE_TTL = 3600;

export const interviewCacheKey = (id: string) => `interview:${id}`;
export const interviewLockKey = (id: string) => `lock:interview:${id}`;

/** DB stores lowercase snake-case statuses; the domain uses the enum. */
const DB_TO_DOMAIN_STATUS: Record<string, InterviewStatus> = {
  pending: InterviewStatus.PENDING,
  in_progress: InterviewStatus.IN_PROGRESS,
  completed: InterviewStatus.COMPLETED,
  cancelled: InterviewStatus.CANCELLED,
};

export function interviewStatusFromDb(status: string): InterviewStatus {
  return DB_TO_DOMAIN_STATUS[status] ?? (status as InterviewStatus);
}

/** Loads a stored feedback row (or null) mapped to the domain shape. */
export async function findStoredFeedback(
  drizzle: DrizzleService,
  interviewId: string,
): Promise<InterviewFeedback | null> {
  const rows = await drizzle.db
    .select()
    .from(feedback)
    .where(eq(feedback.interviewId, interviewId))
    .limit(1);
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    technical: r.technical,
    communication: r.communication,
    confidence: r.confidence,
    clarity: r.clarity,
    overall: r.overall,
    summary: r.summary,
    strengths: r.strengths ?? [],
    improvements: r.improvements ?? [],
  };
}

/** Rebuilds an Interview aggregate from PostgreSQL (interview row + ordered messages). */
export async function reconstructInterviewFromDb(
  drizzle: DrizzleService,
  interviewId: string,
): Promise<Interview> {
  const db = drizzle.db;
  const rows = await db.select().from(interviews).where(eq(interviews.id, interviewId)).limit(1);
  if (rows.length === 0) throw new NotFoundException(`Interview ${interviewId} not found`);
  const row = rows[0];

  const msgRows = await db
    .select()
    .from(messages)
    .where(eq(messages.interviewId, interviewId))
    .orderBy(asc(messages.createdAt));

  // Messages are persisted as [answer, evaluation, next question], so the most
  // recent interviewer message is the question currently awaiting an answer.
  const lastInterviewerMsg = [...msgRows].reverse().find((m) => m.role === 'interviewer');

  return Interview.fromJSON({
    id: row.id,
    userId: row.userId,
    candidateId: row.candidateName ?? row.userId,
    role: row.role,
    language: row.language,
    experienceLevel: row.experienceLevel,
    interviewer: row.interviewer,
    status: interviewStatusFromDb(row.status),
    sessionVariant: row.sessionVariant,
    maxQuestions: row.maxQuestions ?? 10,
    messages: msgRows.map((m) => ({
      role: m.role as 'interviewer' | 'candidate',
      content: m.content,
      timestamp: m.createdAt,
    })),
    currentQuestion: lastInterviewerMsg?.content ?? null,
    visionMetrics: [],
    feedback: null,
    createdAt: row.createdAt,
    updatedAt: row.createdAt,
  });
}

/** Redis first, PostgreSQL fallback when the cache entry has expired. */
export async function loadInterview(
  redis: RedisService,
  drizzle: DrizzleService,
  interviewId: string,
): Promise<Interview> {
  const raw = await redis.get(interviewCacheKey(interviewId));
  if (raw) return Interview.fromJSON(JSON.parse(raw) as Record<string, unknown>);
  return reconstructInterviewFromDb(drizzle, interviewId);
}

/**
 * Appends messages in a single INSERT. Timestamps are spaced 1ms apart so
 * ORDER BY created_at reproduces the insertion order on reconstruction.
 */
export async function persistInterviewMessages(
  drizzle: DrizzleService,
  interviewId: string,
  msgs: Array<{ role: 'interviewer' | 'candidate'; content: string }>,
): Promise<void> {
  if (msgs.length === 0) return;
  const base = Date.now();
  await drizzle.db.insert(messages).values(
    msgs.map((m, i) => ({
      interviewId,
      role: m.role,
      content: m.content,
      createdAt: new Date(base + i),
    })),
  );
}
