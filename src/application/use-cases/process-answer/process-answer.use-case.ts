import { Injectable, Inject, ForbiddenException, Logger } from '@nestjs/common';
import { speakBestEffort } from '../../services/speech';
import { WordTiming } from '../../../domain/interfaces/tts.interface';
import { randomUUID } from 'crypto';
import { Interview, Interviewer } from '../../../domain/entities/interview.entity';
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
import {
  AllQuestionsAnsweredException,
  InterviewBusyException,
  InterviewNotInProgressException,
} from '../../errors/interview.errors';

export interface ProcessAnswerResult {
  aiResponse: string;
  nextQuestion: string | null;
  audioBase64: string | null;
  /** Word timings of `audioBase64` (lip-sync) */
  words: WordTiming[];
  /** Spoken version of `aiResponse` (null when TTS is unavailable) */
  responseAudioBase64: string | null;
  responseWords: WordTiming[];
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

  /** Loads the interview (Redis, then PostgreSQL) and verifies it belongs to `userId`. */
  async loadOwnedInterview(interviewId: string, userId: string): Promise<Interview> {
    const interview = await loadInterview(this.redisService, this.drizzleService, interviewId);
    if (interview.userId !== userId) {
      throw new ForbiddenException('Access denied to this interview');
    }
    return interview;
  }

  /**
   * Loads the interview and verifies it belongs to `userId` and still accepts answers.
   * Exposed so callers can fail fast (e.g. before running STT on an audio answer).
   */
  async loadAnswerableInterview(interviewId: string, userId: string): Promise<Interview> {
    const interview = await this.loadOwnedInterview(interviewId, userId);
    if (interview.status !== InterviewStatus.IN_PROGRESS) {
      throw new InterviewNotInProgressException();
    }
    const answered = interview.messages.filter((m) => m.role === 'candidate').length;
    if (answered >= interview.maxQuestions) {
      throw new AllQuestionsAnsweredException();
    }
    return interview;
  }

  async execute(dto: ProcessAnswerDto): Promise<ProcessAnswerResult> {
    // Serialise answers per interview: a double submit (or two tabs) must not
    // evaluate the same question twice or interleave Redis/DB writes.
    const lockKey = interviewLockKey(dto.interviewId);
    const acquired = await this.redisService.setNx(lockKey, randomUUID(), LOCK_TTL_SECONDS);
    if (!acquired) {
      throw new InterviewBusyException('An answer for this interview is already being processed');
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
      interviewer: interview.interviewer,
    });

    interview.addMessage('interviewer', aiResponse);

    const isComplete = interview.messages.filter((m) => m.role === 'candidate').length >= interview.maxQuestions;

    let nextQuestion: string | null = null;

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
        interviewer: interview.interviewer,
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

    // Voice both the evaluation and the next question with the same neural
    // voice, in parallel, so the browser never falls back to robotic speech.
    const [response, question] = await Promise.all([
      speakBestEffort(this.ttsService, aiResponse, interview.language, interview.interviewer),
      nextQuestion
        ? speakBestEffort(this.ttsService, nextQuestion, interview.language, interview.interviewer)
        : Promise.resolve({ audioBase64: null, words: [] }),
    ]);

    return {
      aiResponse,
      nextQuestion,
      audioBase64: question.audioBase64,
      words: question.words,
      responseAudioBase64: response.audioBase64,
      responseWords: response.words,
      isComplete,
    };
  }
}
