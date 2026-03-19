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
  NotFoundException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../infrastructure/auth/guards/jwt-auth.guard';
import { CurrentUser } from '../decorators/current-user.decorator';
import { FileInterceptor } from '@nestjs/platform-express';
import { StartInterviewUseCase } from '../../application/use-cases/start-interview/start-interview.use-case';
import { ProcessAnswerUseCase } from '../../application/use-cases/process-answer/process-answer.use-case';
import { GenerateFeedbackUseCase } from '../../application/use-cases/generate-feedback/generate-feedback.use-case';
import { CreateInterviewDto, ProcessAnswerDto } from '../../application/dtos/interview.dto';
import { ISTTService } from '../../domain/interfaces/stt.interface';
import { RedisService } from '../../infrastructure/database/redis.service';
import { DrizzleService } from '../../infrastructure/database/drizzle.service';
import { Interview } from '../../domain/entities/interview.entity';
import { interviews, feedback, users } from '../../infrastructure/database/schema';
import { eq, desc } from 'drizzle-orm';

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
        createdAt: interviews.createdAt,
        overall: feedback.overall,
        technical: feedback.technical,
        communication: feedback.communication,
        confidence: feedback.confidence,
        clarity: feedback.clarity,
      })
      .from(interviews)
      .leftJoin(feedback, eq(feedback.interviewId, interviews.id))
      .where(eq(interviews.userId, userId))
      .orderBy(interviews.createdAt)
      .limit(20);

    const completed = rows.filter((r) => r.overall !== null);

    if (completed.length === 0) {
      return { hasData: false, sessions: [], averages: null };
    }

    const sum = (key: 'overall' | 'technical' | 'communication' | 'confidence' | 'clarity') =>
      completed.reduce((acc, r) => acc + (r[key] ?? 0), 0);

    const count = completed.length;
    const averages = {
      overall:       +(sum('overall')       / count).toFixed(1),
      technical:     +(sum('technical')     / count).toFixed(1),
      communication: +(sum('communication') / count).toFixed(1),
      confidence:    +(sum('confidence')    / count).toFixed(1),
      clarity:       +(sum('clarity')       / count).toFixed(1),
    };

    const sessions = completed.map((r, i) => ({
      index:           i + 1,
      role:            r.role,
      experienceLevel: r.experienceLevel,
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
    @Body() body: { cvSummary: string },
    @CurrentUser() currentUser: { userId: string },
  ) {
    await this.drizzleService.db
      .update(users)
      .set({ cvSummary: body.cvSummary.slice(0, 4000) })
      .where(eq(users.id, currentUser.userId));
    return { ok: true };
  }

  @Get('me/history')
  async getUserHistory(@CurrentUser() currentUser: { userId: string }) {
    const userId = currentUser.userId;
    const db = this.drizzleService.db;

    const userRows = await db
      .select()
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
    @Param('id') interviewId: string,
    @CurrentUser() currentUser: { userId: string },
  ) {
    const raw = await this.redisService.get(`interview:${interviewId}`);
    if (!raw) throw new NotFoundException('Interview not found');
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (data.userId !== currentUser.userId) throw new ForbiddenException();
    return Interview.fromJSON(data);
  }

  @Post(':id/answer')
  async processAnswer(
    @Param('id') interviewId: string,
    @Body() dto: ProcessAnswerDto,
    @CurrentUser() currentUser: { userId: string },
  ) {
    return this.processAnswerUseCase.execute({
      ...dto,
      interviewId,
      userId: currentUser.userId,
    });
  }

  @Post(':id/answer/audio')
  @UseInterceptors(FileInterceptor('audio'))
  async processAudioAnswer(
    @Param('id') interviewId: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() currentUser: { userId: string },
  ) {
    const transcript = await this.sttService.transcribe(file.buffer, file.mimetype);
    const result = await this.processAnswerUseCase.execute({
      interviewId,
      answer: transcript,
      userId: currentUser.userId,
    });
    return { transcript, ...result };
  }

  @Post(':id/feedback')
  async generateFeedback(
    @Param('id') interviewId: string,
    @CurrentUser() currentUser: { userId: string },
  ) {
    return this.generateFeedbackUseCase.execute({
      interviewId,
      userId: currentUser.userId,
    });
  }
}
