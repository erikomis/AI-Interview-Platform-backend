import { Injectable, Inject, NotFoundException, ForbiddenException } from '@nestjs/common';
import { Interview, InterviewFeedback } from '../../../domain/entities/interview.entity';
import { IAIService } from '../../../domain/interfaces/ai.interface';
import { RedisService } from '../../../infrastructure/database/redis.service';
import { DrizzleService } from '../../../infrastructure/database/drizzle.service';
import { interviews, messages, feedback, users } from '../../../infrastructure/database/schema';
import { eq, asc } from 'drizzle-orm';
import { GenerateFeedbackDto } from './generate-feedback.dto';
import { MailService } from '../../../infrastructure/mail/mail.service';

@Injectable()
export class GenerateFeedbackUseCase {
  constructor(
    @Inject('IAIService') private readonly aiService: IAIService,
    private readonly redisService: RedisService,
    private readonly drizzleService: DrizzleService,
    private readonly mailService: MailService,
  ) {}

  async execute(dto: GenerateFeedbackDto): Promise<InterviewFeedback> {
    const raw = await this.redisService.get(`interview:${dto.interviewId}`);
    let interview: Interview;

    if (raw) {
      interview = Interview.fromJSON(JSON.parse(raw) as Record<string, unknown>);
    } else {
      // Fallback: reconstruct from DB when Redis TTL has expired
      interview = await this.reconstructFromDb(dto.interviewId);
    }

    if (interview.userId !== dto.userId) {
      throw new ForbiddenException('Access denied to this interview');
    }

    const fb = await this.aiService.generateFeedback({
      conversationHistory: interview.getConversationHistory(),
      visionMetrics: interview.getAverageVisionMetrics(),
      role: interview.role,
      candidateName: interview.candidateId,
      experienceLevel: interview.experienceLevel,
      sessionVariant: interview.sessionVariant,
      language: interview.language,
    });

    interview.complete(fb);

    // Update Redis with completed state (24h TTL)
    await this.redisService.set(`interview:${interview.id}`, JSON.stringify(interview), 86400);

    // Persist to PostgreSQL atomically
    await this.persistToDatabase(interview, fb);

    // Fire-and-forget feedback email
    this.sendFeedbackEmail(interview, fb).catch(() => {/* best-effort */});

    return fb;
  }

  private async persistToDatabase(interview: Interview, fb: InterviewFeedback) {
    const db = this.drizzleService.db;

    // Compute topics covered for future session deduplication
    const topicsCovered = [`${interview.experienceLevel}-variant${interview.sessionVariant}`];

    await db.transaction(async (tx) => {
      await tx
        .update(interviews)
        .set({ status: 'completed', completedAt: new Date(), topicsCovered })
        .where(eq(interviews.id, interview.id));

      if (interview.messages.length > 0) {
        await tx.insert(messages).values(
          interview.messages.map((m) => ({
            interviewId: interview.id,
            role: m.role,
            content: m.content,
            createdAt: new Date(m.timestamp),
          })),
        );
      }

      await tx
        .insert(feedback)
        .values({
          interviewId: interview.id,
          technical: fb.technical,
          communication: fb.communication,
          confidence: fb.confidence,
          clarity: fb.clarity,
          overall: fb.overall,
          summary: fb.summary,
          strengths: fb.strengths,
          improvements: fb.improvements,
        })
        .onConflictDoNothing();
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

  private async reconstructFromDb(interviewId: string): Promise<Interview> {
    const db = this.drizzleService.db;
    const rows = await db.select().from(interviews).where(eq(interviews.id, interviewId)).limit(1);
    if (rows.length === 0) throw new NotFoundException(`Interview ${interviewId} not found`);
    const row = rows[0];

    const msgRows = await db
      .select()
      .from(messages)
      .where(eq(messages.interviewId, interviewId))
      .orderBy(asc(messages.createdAt));

    const lastInterviewerMsg = [...msgRows].reverse().find((m) => m.role === 'interviewer');

    return Interview.fromJSON({
      id: row.id,
      userId: row.userId,
      candidateId: (row as Record<string, unknown>).candidateName ?? row.userId,
      role: row.role,
      language: row.language,
      experienceLevel: row.experienceLevel,
      status: row.status,
      sessionVariant: row.sessionVariant,
      maxQuestions: (row as Record<string, unknown>).maxQuestions ?? 10,
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
}
