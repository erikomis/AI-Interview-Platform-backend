import { Injectable, Inject, NotFoundException, ForbiddenException, Logger } from '@nestjs/common';
import { Interview } from '../../../domain/entities/interview.entity';
import { IAIService } from '../../../domain/interfaces/ai.interface';
import { ITTSService } from '../../../domain/interfaces/tts.interface';
import { RedisService } from '../../../infrastructure/database/redis.service';
import { DrizzleService } from '../../../infrastructure/database/drizzle.service';
import { interviews, messages } from '../../../infrastructure/database/schema';
import { eq, asc } from 'drizzle-orm';
import { ProcessAnswerDto } from './process-answer.dto';

export interface ProcessAnswerResult {
  aiResponse: string;
  nextQuestion: string | null;
  audioBase64: string | null;
  isComplete: boolean;
}

@Injectable()
export class ProcessAnswerUseCase {
  private readonly logger = new Logger(ProcessAnswerUseCase.name);

  constructor(
    @Inject('IAIService') private readonly aiService: IAIService,
    @Inject('ITTSService') private readonly ttsService: ITTSService,
    private readonly redisService: RedisService,
    private readonly drizzleService: DrizzleService,
  ) {}

  async execute(dto: ProcessAnswerDto): Promise<ProcessAnswerResult> {
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
      });

      interview.setCurrentQuestion(nextQuestion);
      interview.addMessage('interviewer', nextQuestion);

      try {
        const audioBuffer = await this.ttsService.synthesize(nextQuestion, interview.language);
        if (audioBuffer) audioBase64 = audioBuffer.toString('base64');
      } catch {
        // TTS is best-effort
      }
    }

    await this.redisService.set(
      `interview:${interview.id}`,
      JSON.stringify(interview),
      3600,
    );

    return { aiResponse, nextQuestion, audioBase64, isComplete };
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
