import {
  Controller,
  Post,
  Body,
  Get,
  Param,
  UploadedFile,
  UseInterceptors,
  UseGuards,
  HttpCode,
  HttpStatus,
  Inject,
  ForbiddenException,
  BadRequestException,
  ParseUUIDPipe,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../infrastructure/auth/guards/jwt-auth.guard';
import { CurrentUser } from '../decorators/current-user.decorator';
import { FileInterceptor } from '@nestjs/platform-express';
import { StartInterviewUseCase } from '../../application/use-cases/start-interview/start-interview.use-case';
import { ProcessAnswerUseCase } from '../../application/use-cases/process-answer/process-answer.use-case';
import { GenerateFeedbackUseCase } from '../../application/use-cases/generate-feedback/generate-feedback.use-case';
import { CreateInterviewDto, ProcessAnswerBodyDto, UpdateCvDto } from '../../application/dtos/interview.dto';
import { ISTTService } from '../../domain/interfaces/stt.interface';
import { RedisService } from '../../infrastructure/database/redis.service';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import { interviews, feedback, users } from '../../infrastructure/database/schema';
import { eq, desc, and } from 'drizzle-orm';
import { findStoredFeedback, loadInterview } from '../../application/services/interview-store';

// Audio answers: ~10MB is several minutes of compressed speech
const MAX_AUDIO_UPLOAD_BYTES = 10 * 1024 * 1024;

@Controller('interviews')
@UseGuards(JwtAuthGuard)
export class InterviewController {
  constructor(
    private readonly startInterviewUseCase: StartInterviewUseCase,
    private readonly processAnswerUseCase: ProcessAnswerUseCase,
    private readonly generateFeedbackUseCase: GenerateFeedbackUseCase,
    @Inject('ISTTService') private readonly sttService: ISTTService,
    private readonly redisService: RedisService,
    private readonly drizzleService: DrizzleService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createInterview(
    @Body() dto: CreateInterviewDto,
    @CurrentUser() currentUser: { userId: string },
  ) {
    const result = await this.startInterviewUseCase.execute({
      ...dto,
      userId: currentUser.userId,
    });
    return {
      interviewId: result.interview.id,
      firstQuestion: result.firstQuestion,
      audioBase64: result.audioBase64,
    };
  }

  // ── History ─────────────────────────────────────────────────────────────────
  // MUST be declared before /:id to prevent Express matching "me" as a param

  @Get('me/analytics')
  async getAnalytics(@CurrentUser() currentUser: { userId: string }) {
    const userId = currentUser.userId;
    const db = this.drizzleService.db;

    const rows = await db
      .select({
        id: interviews.id,
        role: interviews.role,
        experienceLevel: interviews.experienceLevel,
        interviewer: interviews.interviewer,
        createdAt: interviews.createdAt,
        overall: feedback.overall,
        technical: feedback.technical,
        communication: feedback.communication,
        confidence: feedback.confidence,
        clarity: feedback.clarity,
      })
      .from(interviews)
      .innerJoin(feedback, eq(feedback.interviewId, interviews.id))
      .where(and(eq(interviews.userId, userId), eq(interviews.status, 'completed')))
      // Latest 20 completed sessions, then back to chronological order for charts
      .orderBy(desc(interviews.createdAt))
      .limit(20);

    const completed = rows.reverse();

    if (completed.length === 0) {
      return { hasData: false, sessions: [], averages: null };
    }

    // Ignore non-finite scores so one malformed row can't turn an average into NaN
    const avg = (key: 'overall' | 'technical' | 'communication' | 'confidence' | 'clarity') => {
      const values = completed.map((r) => r[key]).filter((v): v is number => Number.isFinite(v));
      return values.length > 0 ? +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(1) : null;
    };

    const count = completed.length;
    const averages = {
      overall:       avg('overall'),
      technical:     avg('technical'),
      communication: avg('communication'),
      confidence:    avg('confidence'),
      clarity:       avg('clarity'),
    };

    const sessions = completed.map((r, i) => ({
      index:           i + 1,
      role:            r.role,
      experienceLevel: r.experienceLevel,
      interviewer:     r.interviewer,
      date:            r.createdAt,
      overall:         r.overall,
      technical:       r.technical,
      communication:   r.communication,
      confidence:      r.confidence,
      clarity:         r.clarity,
    }));

    return { hasData: true, sessions, averages, totalSessions: count };
  }

  @Post('me/cv')
  @HttpCode(HttpStatus.OK)
  async updateCv(
    @Body() body: UpdateCvDto,
    @CurrentUser() currentUser: { userId: string },
  ) {
    await this.drizzleService.db
      .update(users)
      .set({ cvSummary: body.cvSummary })
      .where(eq(users.id, currentUser.userId));
    return { ok: true };
  }

  @Get('me/history')
  async getUserHistory(@CurrentUser() currentUser: { userId: string }) {
    const userId = currentUser.userId;
    const db = this.drizzleService.db;

    // Explicit column list — never leak passwordHash or other internal fields
    const userRows = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        emailVerified: users.emailVerified,
        cvSummary: users.cvSummary,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (userRows.length === 0) return { user: null, interviews: [] };
    const user = userRows[0];

    const rows = await db
      .select({
        id: interviews.id,
        role: interviews.role,
        language: interviews.language,
        experienceLevel: interviews.experienceLevel,
        interviewer: interviews.interviewer,
        status: interviews.status,
        createdAt: interviews.createdAt,
        completedAt: interviews.completedAt,
        overall: feedback.overall,
        technical: feedback.technical,
        communication: feedback.communication,
        confidence: feedback.confidence,
        clarity: feedback.clarity,
        summary: feedback.summary,
        strengths: feedback.strengths,
        improvements: feedback.improvements,
      })
      .from(interviews)
      .leftJoin(feedback, eq(feedback.interviewId, interviews.id))
      .where(eq(interviews.userId, userId))
      .orderBy(desc(interviews.createdAt))
      .limit(50);

    return { user, interviews: rows };
  }

  @Get(':id')
  async getInterview(
    @Param('id', ParseUUIDPipe) interviewId: string,
    @CurrentUser() currentUser: { userId: string },
  ) {
    // Redis while the session is live, PostgreSQL once the cache has expired
    const interview = await loadInterview(this.redisService, this.drizzleService, interviewId);
    if (interview.userId !== currentUser.userId) throw new ForbiddenException();
    if (!interview.feedback) {
      interview.feedback = await findStoredFeedback(this.drizzleService, interview.id);
    }
    return interview;
  }

  @Post(':id/answer')
  async processAnswer(
    @Param('id', ParseUUIDPipe) interviewId: string,
    @Body() dto: ProcessAnswerBodyDto,
    @CurrentUser() currentUser: { userId: string },
  ) {
    return this.processAnswerUseCase.execute({
      answer: dto.answer,
      visionMetrics: dto.visionMetrics,
      interviewId,
      userId: currentUser.userId,
    });
  }

  @Post(':id/answer/audio')
  @UseInterceptors(FileInterceptor('audio', { limits: { fileSize: MAX_AUDIO_UPLOAD_BYTES, files: 1 } }))
  async processAudioAnswer(
    @Param('id', ParseUUIDPipe) interviewId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() currentUser: { userId: string },
  ) {
    if (!file || !file.buffer || file.size === 0) {
      throw new BadRequestException('Missing "audio" file');
    }

    // Check ownership/state before spending STT time; transcribe in the interview's language
    const interview = await this.processAnswerUseCase.loadAnswerableInterview(interviewId, currentUser.userId);
    const transcript = (await this.sttService.transcribe(file.buffer, file.mimetype, interview.language)).trim();
    if (!transcript) {
      throw new BadRequestException('Could not understand the audio — please try again');
    }

    const result = await this.processAnswerUseCase.execute({
      interviewId,
      answer: transcript,
      userId: currentUser.userId,
    });
    return { transcript, ...result };
  }

  @Post(':id/feedback')
  async generateFeedback(
    @Param('id', ParseUUIDPipe) interviewId: string,
    @CurrentUser() currentUser: { userId: string },
  ) {
    return this.generateFeedbackUseCase.execute({
      interviewId,
      userId: currentUser.userId,
    });
  }
}
