import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger, Inject } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'socket.io';
import { StartInterviewUseCase } from '../../application/use-cases/start-interview/start-interview.use-case';
import { ProcessAnswerUseCase } from '../../application/use-cases/process-answer/process-answer.use-case';
import { GenerateFeedbackUseCase } from '../../application/use-cases/generate-feedback/generate-feedback.use-case';
import { ISTTService } from '../../domain/interfaces/stt.interface';
import { IVisionService } from '../../domain/interfaces/vision.interface';

@WebSocketGateway({
  cors: {
    origin: (process.env.CORS_ORIGIN || 'http://localhost:3001').split(',').map((o) => o.trim()),
    credentials: true,
  },
  namespace: '/interview',
})
export class InterviewGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(InterviewGateway.name);

  constructor(
    private readonly startInterviewUseCase: StartInterviewUseCase,
    private readonly processAnswerUseCase: ProcessAnswerUseCase,
    private readonly generateFeedbackUseCase: GenerateFeedbackUseCase,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Inject('ISTTService') private readonly sttService: ISTTService,
    @Inject('IVisionService') private readonly visionService: IVisionService,
  ) {}

  afterInit() {
    this.logger.log('InterviewGateway initialized');
  }

  // ── Parse a single cookie value from the Cookie header ──────────────────────
  private parseCookie(cookieHeader: string, name: string): string | null {
    const entry = cookieHeader.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
    return entry ? entry.slice(name.length + 1) : null;
  }

  // ── Authenticate every WS connection via httpOnly access_token cookie ────────
  handleConnection(client: Socket) {
    const cookieHeader = (client.handshake.headers?.cookie as string) ?? '';
    const token = this.parseCookie(cookieHeader, 'access_token');

    if (!token) {
      this.logger.warn(`WS rejected (no token): ${client.id}`);
      client.emit('error', { message: 'Unauthorized' });
      client.disconnect(true);
      return;
    }

    try {
      const payload = this.jwtService.verify(token, {
        secret: this.configService.get<string>('JWT_ACCESS_SECRET'),
      });
      // Attach user to socket data for later use
      client.data.userId = payload.sub;
      client.data.email = payload.email;
      this.logger.log(`WS connected: ${client.id} (user: ${payload.email})`);
    } catch {
      this.logger.warn(`WS rejected (invalid token): ${client.id}`);
      client.emit('error', { message: 'Unauthorized' });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  // ── start_interview ─────────────────────────────────────────────────────────
  @SubscribeMessage('start_interview')
  async handleStartInterview(
    @MessageBody()
    data: {
      candidateId: string;
      role: string;
      language?: 'pt' | 'en';
      experienceLevel?: 'junior' | 'mid' | 'senior';
      sessionMode?: 'practice' | 'full' | 'intensive';
      cvSummary?: string;
    },
    @ConnectedSocket() client: Socket,
  ) {
    try {
      const userId: string = client.data.userId as string;
      if (!userId) { client.emit('error', { message: 'Unauthorized' }); return; }
      const result = await this.startInterviewUseCase.execute({ ...data, userId });

      client.join(`interview:${result.interview.id}`);
      client.emit('ai_question', {
        interviewId: result.interview.id,
        question: result.firstQuestion,
        audioBase64: result.audioBase64,
      });
    } catch (err) {
      this.logger.error(`start_interview error: ${(err as Error).message}`, (err as Error).stack);
      client.emit('error', { message: (err as Error).message });
    }
  }

  // ── user_answer ─────────────────────────────────────────────────────────────
  @SubscribeMessage('user_answer')
  async handleUserAnswer(
    @MessageBody()
    data: {
      interviewId: string;
      answer: string;
      visionMetrics?: { eye_contact: number; stress_level: number; confidence: number };
    },
    @ConnectedSocket() client: Socket,
  ) {
    try {
      const userId: string = client.data.userId as string;
      if (!userId) { client.emit('error', { message: 'Unauthorized' }); return; }
      const result = await this.processAnswerUseCase.execute({ ...data, userId });

      client.emit('ai_response', { interviewId: data.interviewId, response: result.aiResponse });

      if (result.isComplete) {
        const feedback = await this.generateFeedbackUseCase.execute({
          interviewId: data.interviewId,
          userId,
        });
        client.emit('final_feedback', { interviewId: data.interviewId, feedback });
      } else {
        client.emit('ai_question', {
          interviewId: data.interviewId,
          question: result.nextQuestion,
          audioBase64: result.audioBase64,
        });
      }
    } catch (err) {
      this.logger.error(`user_answer error: ${(err as Error).message}`, (err as Error).stack);
      client.emit('error', { message: (err as Error).message });
    }
  }

  // ── audio_answer ────────────────────────────────────────────────────────────
  @SubscribeMessage('audio_answer')
  async handleAudioAnswer(
    @MessageBody()
    data: {
      interviewId: string;
      audioBase64: string;
      mimeType?: string;
      language?: string;
      visionMetrics?: { eye_contact: number; stress_level: number; confidence: number };
    },
    @ConnectedSocket() client: Socket,
  ) {
    try {
      const userId: string = client.data.userId as string;
      if (!userId) { client.emit('error', { message: 'Unauthorized' }); return; }
      const audioBuffer = Buffer.from(data.audioBase64, 'base64');
      const transcript = await this.sttService.transcribe(audioBuffer, data.mimeType, data.language ?? 'pt');

      client.emit('transcript', { interviewId: data.interviewId, text: transcript });

      const result = await this.processAnswerUseCase.execute({
        interviewId: data.interviewId,
        answer: transcript,
        userId,
        visionMetrics: data.visionMetrics,
      });

      client.emit('ai_response', { interviewId: data.interviewId, response: result.aiResponse });

      if (result.isComplete) {
        const feedback = await this.generateFeedbackUseCase.execute({
          interviewId: data.interviewId,
          userId,
        });
        client.emit('final_feedback', { interviewId: data.interviewId, feedback });
      } else {
        client.emit('ai_question', {
          interviewId: data.interviewId,
          question: result.nextQuestion,
          audioBase64: result.audioBase64,
        });
      }
    } catch (err) {
      this.logger.error(`audio_answer error: ${(err as Error).message}`, (err as Error).stack);
      client.emit('error', { message: (err as Error).message });
    }
  }

  // ── vision_metrics ──────────────────────────────────────────────────────────
  @SubscribeMessage('vision_metrics')
  async handleVisionMetrics(
    @MessageBody()
    data: {
      interviewId: string;
      frameBase64?: string;
      metrics?: { eye_contact: number; stress_level: number; confidence: number };
    },
    @ConnectedSocket() client: Socket,
  ) {
    // If the client already computed metrics client-side, emit them directly
    if (data.metrics) {
      client.emit('vision_result', { interviewId: data.interviewId, metrics: data.metrics });
      return;
    }

    // Otherwise process the raw frame server-side
    if (!data.frameBase64) return;
    try {
      const frameBuffer = Buffer.from(data.frameBase64, 'base64');
      const metrics = await this.visionService.processFrame(frameBuffer);
      if (metrics) {
        client.emit('vision_result', { interviewId: data.interviewId, metrics });
      }
    } catch (err) {
      this.logger.warn('Vision processing failed', err);
    }
  }
}
