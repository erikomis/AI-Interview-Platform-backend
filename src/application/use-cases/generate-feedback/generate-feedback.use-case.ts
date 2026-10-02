import { Injectable, Inject, Optional, ForbiddenException, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Interview, InterviewFeedback } from '../../../domain/entities/interview.entity';
import { InterviewStatus } from '../../../domain/value-objects/interview-status.vo';
import { IAIService } from '../../../domain/interfaces/ai.interface';
import { IVisionService } from '../../../domain/interfaces/vision.interface';
import { RedisService } from '../../../infrastructure/database/redis.service';
import { DrizzleService } from '../../../infrastructure/database/drizzle.service';
import { interviews, feedback, users } from '../../../infrastructure/database/schema';
import { eq } from 'drizzle-orm';
import { GenerateFeedbackDto } from './generate-feedback.dto';
import { MailService } from '../../../infrastructure/mail/mail.service';
import {
  findStoredFeedback,
  interviewCacheKey,
  interviewLockKey,
  loadInterview,
} from '../../services/interview-store';
import { InterviewBusyException, InterviewNotInProgressException } from '../../errors/interview.errors';

// Feedback is a single (long) LLM call — keep the lock comfortably above its 120s timeout
const LOCK_TTL_SECONDS = 180;

@Injectable()
export class GenerateFeedbackUseCase {
  private readonly logger = new Logger(GenerateFeedbackUseCase.name);

  constructor(
    @Inject('IAIService') private readonly aiService: IAIService,
    private readonly redisService: RedisService,
    private readonly drizzleService: DrizzleService,
    private readonly mailService: MailService,
    @Optional() @Inject('IVisionService') private readonly visionService?: IVisionService,
  ) {}

  /**
   * Idempotent: once feedback is stored, every later call (e.g. a client retry
   * after `feedback_failed`) returns the stored result instead of regenerating.
   */
  async execute(dto: GenerateFeedbackDto): Promise<InterviewFeedback> {
    const interview = await loadInterview(this.redisService, this.drizzleService, dto.interviewId);

    if (interview.userId !== dto.userId) {
      throw new ForbiddenException('Access denied to this interview');
    }

    const stored = await findStoredFeedback(this.drizzleService, interview.id);
    if (stored) return stored;

    if (interview.status !== InterviewStatus.IN_PROGRESS) {
      throw new InterviewNotInProgressException();
    }

    // Shares the per-interview lock with ProcessAnswer: no feedback while an
    // answer is still being processed, and no two concurrent generations.
    const lockKey = interviewLockKey(interview.id);
    const acquired = await this.redisService.setNx(lockKey, randomUUID(), LOCK_TTL_SECONDS);
    if (!acquired) {
      throw new InterviewBusyException();
    }

    try {
      return await this.generate(interview);
    } finally {
      await this.redisService.del(lockKey).catch(() => {/* expires via TTL */});
    }
  }

  private async generate(interview: Interview): Promise<InterviewFeedback> {
    const fb = await this.aiService.generateFeedback({
      conversationHistory: interview.getConversationHistory(),
      visionMetrics: interview.getAverageVisionMetrics(),
      role: interview.role,
      candidateName: interview.candidateId,
      experienceLevel: interview.experienceLevel,
      sessionVariant: interview.sessionVariant,
      language: interview.language,
      interviewer: interview.interviewer,
    });

    interview.complete(fb);

    // Persist to PostgreSQL atomically (messages were already saved incrementally)
    await this.persistToDatabase(interview, fb);

    // Update Redis with completed state (24h TTL)
    await this.redisService.set(interviewCacheKey(interview.id), JSON.stringify(interview), 86400);

    // Best-effort: drop the vision service's per-session smoothing state
    this.visionService?.endSession(interview.id).catch(() => {/* best-effort */});

    // Fire-and-forget feedback email
    this.sendFeedbackEmail(interview, fb).catch((err: Error) =>
      this.logger.warn(`Feedback email failed: ${err.message}`),
    );

    return fb;
  }

  private async persistToDatabase(interview: Interview, fb: InterviewFeedback) {
    const db = this.drizzleService.db;

    // Compute topics covered for future session deduplication
    const topicsCovered = [`${interview.experienceLevel}-variant${interview.sessionVariant}`];

    const values = {
      technical: fb.technical,
      communication: fb.communication,
      confidence: fb.confidence,
      clarity: fb.clarity,
      overall: fb.overall,
      summary: fb.summary,
      strengths: fb.strengths,
      improvements: fb.improvements,
    };

    await db.transaction(async (tx) => {
      await tx
        .update(interviews)
        .set({ status: 'completed', completedAt: new Date(), topicsCovered })
        .where(eq(interviews.id, interview.id));

      await tx
        .insert(feedback)
        .values({ interviewId: interview.id, ...values })
        .onConflictDoUpdate({ target: feedback.interviewId, set: values });
    });
  }

  private async sendFeedbackEmail(interview: Interview, fb: InterviewFeedback): Promise<void> {
    const db = this.drizzleService.db;
    const userRows = await db.select({ email: users.email, name: users.name })
      .from(users)
      .where(eq(users.id, interview.userId))
      .limit(1);
    if (userRows.length === 0) return;
    const { email, name } = userRows[0];
    await this.mailService.sendInterviewFeedback(
      email, name, interview.role, interview.experienceLevel,
      interview.language, fb,
    );
  }
}
