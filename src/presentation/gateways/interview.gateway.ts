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
import { Logger, Inject, UsePipes, UseFilters } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Namespace, Socket } from 'socket.io';
import { StartInterviewUseCase } from '../../application/use-cases/start-interview/start-interview.use-case';
import { ProcessAnswerUseCase, ProcessAnswerResult } from '../../application/use-cases/process-answer/process-answer.use-case';
import { GenerateFeedbackUseCase } from '../../application/use-cases/generate-feedback/generate-feedback.use-case';
import { ISTTService } from '../../domain/interfaces/stt.interface';
import { IVisionService } from '../../domain/interfaces/vision.interface';
import {
  WsStartInterviewDto,
  WsUserAnswerDto,
  WsAudioAnswerDto,
  WsVisionMetricsDto,
} from '../../application/dtos/interview.dto';
import { WsValidationPipe } from '../pipes/ws-validation.pipe';
import { WsErrorFilter } from '../filters/ws-exception.filter';

// ── WebSocket contract ────────────────────────────────────────────────────────
// Auth:   handshake cookie `access_token`; failure → connect_error "unauthorized".
// In:     start_interview, user_answer, audio_answer, vision_metrics
// Out:    ai_question, ai_response, transcript, final_feedback, feedback_failed,
//         vision_result, auth_expired, error { message }

// Read lazily so values loaded from .env by ConfigModule are honoured
// (decorator arguments are evaluated at import time, before ConfigModule runs).
const allowedOrigins = () =>
  (process.env.CORS_ORIGIN || 'http://localhost:3001').split(',').map((o) => o.trim());

// Token-bucket limits per socket: capacity / refill rate (tokens per second)
const RATE_LIMITS = {
  start:  { capacity: 1, refillPerSec: 0.5 }, // 1 every 2s
  answer: { capacity: 1, refillPerSec: 0.5 }, // shared by user_answer + audio_answer
  vision: { capacity: 2, refillPerSec: 2 },   // 2 frames per second
} as const;
type RateBucket = keyof typeof RATE_LIMITS;

interface SocketData {
  userId?: string;
  email?: string;
  /** JWT `exp` (seconds since epoch) of the access token used at handshake */
  exp?: number;
  buckets?: Partial<Record<RateBucket, { tokens: number; last: number }>>;
  /** Interview ids already verified to belong to this socket's user */
  ownedInterviews?: Set<string>;
}

@WebSocketGateway({
  cors: {
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      if (!origin || allowedOrigins().includes(origin)) callback(null, true);
      else callback(new Error(`Origin ${origin} not allowed by CORS`), false);
    },
    credentials: true,
  },
  namespace: '/interview',
  // Audio answers arrive as base64 in a single message (default limit is 1MB)
  maxHttpBufferSize: 15 * 1024 * 1024,
  // Long AI/STT turns + large uploads on slow links shouldn't drop the socket
  pingTimeout: 60_000,
})
@UsePipes(new WsValidationPipe())
@UseFilters(new WsErrorFilter())
export class InterviewGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Namespace;

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

  // ── Authenticate every WS connection via httpOnly access_token cookie ────────
  // Done in a namespace middleware so a bad/missing token surfaces client-side
  // as `connect_error` (err.message === 'unauthorized') instead of a silent drop.
  afterInit(server: Namespace) {
    server.use((socket, next) => {
      const cookieHeader = (socket.handshake.headers?.cookie as string) ?? '';
      const token = this.parseCookie(cookieHeader, 'access_token');

      if (!token) {
        this.logger.warn(`WS rejected (no token): ${socket.id}`);
        return next(new Error('unauthorized'));
      }

      try {
        const payload = this.jwtService.verify<{ sub: string; email: string; exp?: number }>(token, {
          secret: this.configService.get<string>('JWT_ACCESS_SECRET'),
        });
        const data = socket.data as SocketData;
        data.userId = payload.sub;
        data.email = payload.email;
        data.exp = payload.exp;
        data.ownedInterviews = new Set<string>();
        next();
      } catch {
        this.logger.warn(`WS rejected (invalid token): ${socket.id}`);
        next(new Error('unauthorized'));
      }
    });
    this.logger.log('InterviewGateway initialized');
  }

  // ── Parse a single cookie value from the Cookie header ──────────────────────
  private parseCookie(cookieHeader: string, name: string): string | null {
    const entry = cookieHeader.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
    return entry ? entry.slice(name.length + 1) : null;
  }

  handleConnection(client: Socket) {
    this.logger.log(`WS connected: ${client.id} (user: ${(client.data as SocketData).email})`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  // ── Session / rate-limit helpers ─────────────────────────────────────────────

  /**
   * Returns the authenticated userId, or null after notifying the client.
   * The access token is only checked at handshake, so its expiry is enforced here
   * on every event: the client must refresh (REST) and reconnect.
   */
  private requireSession(client: Socket): string | null {
    const data = client.data as SocketData;
    if (!data.userId) {
      client.emit('error', { message: 'Unauthorized' });
      return null;
    }
    if (data.exp && Date.now() >= data.exp * 1000) {
      client.emit('auth_expired', { message: 'Session expired — refresh and reconnect' });
      client.disconnect(true);
      return null;
    }
    return data.userId;
  }

  /** Token bucket stored on the socket — returns false when the event should be dropped. */
  private consume(client: Socket, bucket: RateBucket): boolean {
    const { capacity, refillPerSec } = RATE_LIMITS[bucket];
    const data = client.data as SocketData;
    const buckets = (data.buckets ??= {});
    const now = Date.now();
    const state = buckets[bucket] ?? { tokens: capacity, last: now };
    state.tokens = Math.min(capacity, state.tokens + ((now - state.last) / 1000) * refillPerSec);
    state.last = now;
    buckets[bucket] = state;
    if (state.tokens < 1) return false;
    state.tokens -= 1;
    return true;
  }

  private markOwned(client: Socket, interviewId: string) {
    const data = client.data as SocketData;
    (data.ownedInterviews ??= new Set<string>()).add(interviewId);
  }

  /** Emits the evaluation, then either the next question or the final feedback. */
  private async emitAnswerResult(
    client: Socket,
    interviewId: string,
    userId: string,
    result: ProcessAnswerResult,
  ) {
    client.emit('ai_response', { interviewId, response: result.aiResponse });

    if (!result.isComplete) {
      client.emit('ai_question', {
        interviewId,
        question: result.nextQuestion,
        audioBase64: result.audioBase64,
      });
      return;
    }

    try {
      const feedback = await this.generateFeedbackUseCase.execute({ interviewId, userId });
      client.emit('final_feedback', { interviewId, feedback });
    } catch (err) {
      // All answers are already persisted — the client can retry via
      // REST POST /interviews/:id/feedback (idempotent).
      this.logger.error(`feedback generation failed: ${(err as Error).message}`, (err as Error).stack);
      client.emit('feedback_failed', { interviewId, message: (err as Error).message });
    }
  }

  // ── start_interview ─────────────────────────────────────────────────────────
  @SubscribeMessage('start_interview')
  async handleStartInterview(
    @MessageBody() data: WsStartInterviewDto,
    @ConnectedSocket() client: Socket,
  ) {
    const userId = this.requireSession(client);
    if (!userId) return;
    if (!this.consume(client, 'start')) {
      client.emit('error', { message: 'Too many requests — please wait a moment' });
      return;
    }

    try {
      const result = await this.startInterviewUseCase.execute({ ...data, userId });

      this.markOwned(client, result.interview.id);
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
    @MessageBody() data: WsUserAnswerDto,
    @ConnectedSocket() client: Socket,
  ) {
    const userId = this.requireSession(client);
    if (!userId) return;
    if (!this.consume(client, 'answer')) {
      client.emit('error', { message: 'Too many requests — please wait a moment' });
      return;
    }

    try {
      const result = await this.processAnswerUseCase.execute({ ...data, userId });
      this.markOwned(client, data.interviewId);
      await this.emitAnswerResult(client, data.interviewId, userId, result);
    } catch (err) {
      this.logger.error(`user_answer error: ${(err as Error).message}`, (err as Error).stack);
      client.emit('error', { message: (err as Error).message });
    }
  }

  // ── audio_answer ────────────────────────────────────────────────────────────
  @SubscribeMessage('audio_answer')
  async handleAudioAnswer(
    @MessageBody() data: WsAudioAnswerDto,
    @ConnectedSocket() client: Socket,
  ) {
    const userId = this.requireSession(client);
    if (!userId) return;
    if (!this.consume(client, 'answer')) {
      client.emit('error', { message: 'Too many requests — please wait a moment' });
      return;
    }

    try {
      // Verify ownership/state BEFORE spending STT time, and transcribe in the
      // interview's own language rather than a client-supplied one.
      const interview = await this.processAnswerUseCase.loadAnswerableInterview(data.interviewId, userId);
      this.markOwned(client, interview.id);

      const audioBuffer = Buffer.from(data.audioBase64, 'base64');
      const transcript = (await this.sttService.transcribe(audioBuffer, data.mimeType, interview.language)).trim();

      if (!transcript) {
        client.emit('error', {
          message: interview.language === 'en'
            ? 'Could not understand the audio — please try again'
            : 'Não foi possível entender o áudio — tente novamente',
        });
        return;
      }

      client.emit('transcript', { interviewId: data.interviewId, text: transcript });

      const result = await this.processAnswerUseCase.execute({
        interviewId: data.interviewId,
        answer: transcript,
        userId,
        visionMetrics: data.visionMetrics,
      });

      await this.emitAnswerResult(client, data.interviewId, userId, result);
    } catch (err) {
      this.logger.error(`audio_answer error: ${(err as Error).message}`, (err as Error).stack);
      client.emit('error', { message: (err as Error).message });
    }
  }

  // ── vision_metrics ──────────────────────────────────────────────────────────
  @SubscribeMessage('vision_metrics')
  async handleVisionMetrics(
    @MessageBody() data: WsVisionMetricsDto,
    @ConnectedSocket() client: Socket,
  ) {
    const userId = this.requireSession(client);
    if (!userId) return;
    // High-frequency stream: silently drop excess frames
    if (!this.consume(client, 'vision')) return;

    // If the client already computed metrics client-side, emit them directly
    if (data.metrics) {
      client.emit('vision_result', { interviewId: data.interviewId, metrics: data.metrics });
      return;
    }

    // Otherwise process the raw frame server-side
    if (!data.frameBase64) return;
    try {
      // The interview id doubles as the vision session id — only forward frames
      // for interviews this user owns (verified once, then cached on the socket).
      const owned = (client.data as SocketData).ownedInterviews;
      if (!owned?.has(data.interviewId)) {
        await this.processAnswerUseCase.loadAnswerableInterview(data.interviewId, userId);
        this.markOwned(client, data.interviewId);
      }

      const frameBuffer = Buffer.from(data.frameBase64, 'base64');
      const metrics = await this.visionService.processFrame(frameBuffer, data.interviewId);
      if (metrics) {
        client.emit('vision_result', { interviewId: data.interviewId, metrics });
      }
    } catch (err) {
      this.logger.warn(`Vision processing failed: ${(err as Error).message}`);
    }
  }
}
