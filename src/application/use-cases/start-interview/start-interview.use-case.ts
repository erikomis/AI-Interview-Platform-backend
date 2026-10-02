import { Injectable, Inject } from '@nestjs/common';
import { Interview } from '../../../domain/entities/interview.entity';
import { IAIService } from '../../../domain/interfaces/ai.interface';
import { ITTSService } from '../../../domain/interfaces/tts.interface';
import { RedisService } from '../../../infrastructure/database/redis.service';
import { DrizzleService } from '../../../infrastructure/database/drizzle.service';
import { interviews } from '../../../infrastructure/database/schema';
import { eq, desc } from 'drizzle-orm';
import { StartInterviewDto } from './start-interview.dto';
import {
  INTERVIEW_CACHE_TTL,
  interviewCacheKey,
  persistInterviewMessages,
} from '../../services/interview-store';

export interface StartInterviewResult {
  interview: Interview;
  firstQuestion: string;
  audioBase64: string | null;
}

@Injectable()
export class StartInterviewUseCase {
  constructor(
    @Inject('IAIService') private readonly aiService: IAIService,
    @Inject('ITTSService') private readonly ttsService: ITTSService,
    private readonly redisService: RedisService,
    private readonly drizzleService: DrizzleService,
  ) {}

  async execute(dto: StartInterviewDto): Promise<StartInterviewResult> {
    // userId comes from the authenticated JWT — guaranteed to be present
    const userId = dto.userId;

    const SESSION_QUESTIONS: Record<string, number> = { practice: 5, full: 10, intensive: 15 };
    const maxQuestions = SESSION_QUESTIONS[dto.sessionMode ?? 'full'] ?? 10;

    const interview = new Interview(
      dto.candidateId,
      dto.role,
      dto.language ?? 'pt',
      dto.experienceLevel ?? 'mid',
      userId,
      maxQuestions,
    );
    interview.start();

    // Fetch previous topics from last 3 completed interviews for deduplication
    const prevInterviews = await this.drizzleService.db
      .select({ topicsCovered: interviews.topicsCovered })
      .from(interviews)
      .where(eq(interviews.userId, userId))
      .orderBy(desc(interviews.createdAt))
      .limit(3);

    const previousTopics = prevInterviews
      .flatMap((i) => i.topicsCovered ?? [])
      .slice(0, 20);

    const firstQuestion = await this.aiService.generateQuestion({
      role: dto.role,
      candidateName: dto.candidateId,
      conversationHistory: [],
      visionMetrics: null,
      language: interview.language,
      experienceLevel: interview.experienceLevel,
      sessionVariant: interview.sessionVariant,
      cvContext: dto.cvSummary,
      previousTopics,
      maxQuestions: interview.maxQuestions,
    });

    interview.setCurrentQuestion(firstQuestion);
    interview.addMessage('interviewer', firstQuestion);

    // Register interview row in PostgreSQL, then persist the first question so the
    // session can be fully reconstructed from the DB if the Redis key expires.
    await this.drizzleService.db.insert(interviews).values({
      id: interview.id,
      userId,
      role: interview.role,
      language: interview.language,
      experienceLevel: interview.experienceLevel,
      status: 'in_progress',
      sessionVariant: interview.sessionVariant,
      maxQuestions: interview.maxQuestions,
      candidateName: dto.candidateId,
    });
    await persistInterviewMessages(this.drizzleService, interview.id, [
      { role: 'interviewer', content: firstQuestion },
    ]);

    // Save to Redis for fast access during interview
    await this.redisService.set(interviewCacheKey(interview.id), JSON.stringify(interview), INTERVIEW_CACHE_TTL);

    let audioBase64: string | null = null;
    try {
      const audioBuffer = await this.ttsService.synthesize(firstQuestion, interview.language);
      if (audioBuffer) audioBase64 = audioBuffer.toString('base64');
    } catch {
      // TTS is best-effort
    }

    return { interview, firstQuestion, audioBase64 };
  }
}
