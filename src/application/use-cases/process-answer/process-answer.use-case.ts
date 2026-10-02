import {
  Injectable,
  Inject,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Interview } from '../../../domain/entities/interview.entity';
import { InterviewStatus } from '../../../domain/value-objects/interview-status.vo';
import { IAIService } from '../../../domain/interfaces/ai.interface';
import { ITTSService } from '../../../domain/interfaces/tts.interface';
import { RedisService } from '../../../infrastructure/database/redis.service';
import { DrizzleService } from '../../../infrastructure/database/drizzle.service';
import { ProcessAnswerDto } from './process-answer.dto';
import {
  INTERVIEW_CACHE_TTL,
  interviewCacheKey,
  interviewLockKey,
  loadInterview,
  persistInterviewMessages,
} from '../../services/interview-store';

export interface ProcessAnswerResult {
  aiResponse: string;
  nextQuestion: string | null;
  audioBase64: string | null;
  isComplete: boolean;
}

// Upper bound for one answer: evaluate (≤120s) + next question (≤120s) + TTS (≤30s)
const LOCK_TTL_SECONDS = 300;

@Injectable()
export class ProcessAnswerUseCase {
  private readonly logger = new Logger(ProcessAnswerUseCase.name);

  constructor(
    @Inject('IAIService') private readonly aiService: IAIService,
    @Inject('ITTSService') private readonly ttsService: ITTSService,
    private readonly redisService: RedisService,
    private readonly drizzleService: DrizzleService,
  ) {}

  /**
   * Loads the interview and verifies it belongs to `userId` and still accepts answers.
   * Exposed so callers can fail fast (e.g. before running STT on an audio answer).
   */
  async loadAnswerableInterview(interviewId: string, userId: string): Promise<Interview> {
    const interview = await loadInterview(this.redisService, this.drizzleService, interviewId);

    if (interview.userId !== userId) {
      throw new ForbiddenException('Access denied to this interview');
    }
    if (interview.status !== InterviewStatus.IN_PROGRESS) {
      throw new BadRequestException('Interview is not in progress');
    }
    const answered = interview.messages.filter((m) => m.role === 'candidate').length;
    if (answered >= interview.maxQuestions) {
      throw new BadRequestException('All questions have been answered — request feedback instead');
    }
    return interview;
  }

  async execute(dto: ProcessAnswerDto): Promise<ProcessAnswerResult> {
    // Serialise answers per interview: a double submit (or two tabs) must not
    // evaluate the same question twice or interleave Redis/DB writes.
    const lockKey = interviewLockKey(dto.interviewId);
    const acquired = await this.redisService.setNx(lockKey, randomUUID(), LOCK_TTL_SECONDS);
    if (!acquired) {
      throw new ConflictException('An answer for this interview is already being processed');
    }

    try {
      return await this.process(dto);
    } finally {
      await this.redisService.del(lockKey).catch(() => {/* expires via TTL */});
    }
  }

  private async process(dto: ProcessAnswerDto): Promise<ProcessAnswerResult> {
    const interview = await this.loadAnswerableInterview(dto.interviewId, dto.userId);

    if (dto.visionMetrics) {
      interview.addVisionMetrics(dto.visionMetrics);
    }

    interview.addMessage('candidate', dto.answer);

    const aiResponse = await this.aiService.evaluateAnswer({
      question: interview.currentQuestion ?? '',
      answer: dto.answer,
      role: interview.role,
      visionMetrics: interview.getAverageVisionMetrics(),
      language: interview.language,
    });

    interview.addMessage('interviewer', aiResponse);

    const isComplete = interview.messages.filter((m) => m.role === 'candidate').length >= interview.maxQuestions;

    let nextQuestion: string | null = null;
    let audioBase64: string | null = null;

    if (!isComplete) {
      nextQuestion = await this.aiService.generateQuestion({
        role: interview.role,
        candidateName: interview.candidateId,
        conversationHistory: interview.getConversationHistory(),
        visionMetrics: interview.getAverageVisionMetrics(),
        language: interview.language,
        experienceLevel: interview.experienceLevel,
        sessionVariant: interview.sessionVariant,
        maxQuestions: interview.maxQuestions,
      });

      interview.setCurrentQuestion(nextQuestion);
      interview.addMessage('interviewer', nextQuestion);
    }

    // Persist durably first: if this fails, Redis is left untouched and the
    // candidate can simply resubmit the same answer.
    await persistInterviewMessages(this.drizzleService, interview.id, [
      { role: 'candidate', content: dto.answer },
      { role: 'interviewer', content: aiResponse },
      ...(nextQuestion ? [{ role: 'interviewer' as const, content: nextQuestion }] : []),
    ]);

    await this.redisService.set(
      interviewCacheKey(interview.id),
      JSON.stringify(interview),
      INTERVIEW_CACHE_TTL,
    );

    if (nextQuestion) {
      try {
        const audioBuffer = await this.ttsService.synthesize(nextQuestion, interview.language);
        if (audioBuffer) audioBase64 = audioBuffer.toString('base64');
      } catch {
        // TTS is best-effort
      }
    }

    return { aiResponse, nextQuestion, audioBase64, isComplete };
  }
}
