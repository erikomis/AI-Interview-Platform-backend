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
import { InterviewStatus } from '../../domain/value-objects/interview-status.vo';
import {
  WsStartInterviewDto,
  WsUserAnswerDto,
  WsAudioAnswerDto,
  WsVisionMetricsDto,
} from '../../application/dtos/interview.dto';
import { WsValidationPipe } from '../pipes/ws-validation.pipe';
import { WsErrorFilter } from '../filters/ws-exception.filter';
import { toWsError, wsError } from '../filters/ws-error';

// ── WebSocket contract ────────────────────────────────────────────────────────
// Auth:   handshake cookie `access_token`; failure → connect_error "unauthorized".
//         On connect the server emits `session_info { exp }` (unix seconds).
//         An event sent after `exp` is NOT processed: the server emits
//         `auth_expired` (socket stays open) and the client refreshes + reconnects.
// In:     start_interview { candidateId, role, language?, experienceLevel?,
//                           sessionMode?, cvSummary?, interviewer?: 'male'|'female' }
//         user_answer, audio_answer, vision_metrics
// Out:    ai_question, ai_response, transcript, final_feedback, feedback_failed
//           → emitted to the room `interview:<id>`; every event that proves
//             ownership (re)joins it, so a reconnected socket still gets
//             results of a turn that was in flight when the old one dropped.
//         vision_result, session_info, auth_expired, error { message, code }

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
  /** Interview id → when it was last verified to belong to this socket's user (ms) */
  ownedInterviews?: Map<string, number>;
  /** Interviews whose vision frames are dropped (not in progress / not owned) */
  ignoredVision?: Set<string>;
  /** Last time `auth_expired` was emitted (ms) — avoids flooding during refresh */
  authExpiredAt?: number;
}

// Vision frames re-verify ownership/state at most this often (one Redis read)
const VISION_RECHECK_MS = 10_000;
// While a client is refreshing, high-frequency events would each emit auth_expired
const AUTH_EXPIRED_REPEAT_MS = 5_000;

const roomOf = (interviewId: string) => `interview:${interviewId}`;

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
        data.ownedInterviews = new Map<string, number>();
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
    const data = client.data as SocketData;
    this.logger.log(`WS connected: ${client.id} (user: ${data.email})`);
    // Lets the client schedule a refresh before the access token expires
    client.emit('session_info', { exp: data.exp ?? null });
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  // ── Session / rate-limit helpers ─────────────────────────────────────────────

  /**
   * Returns the authenticated userId, or null after notifying the client.
   * The access token is only checked at handshake, so its expiry is enforced here
   * on every event: the event is dropped and the client must refresh (REST) and
   * reconnect. The socket is NOT closed, so results of a turn already in flight
   * are still delivered (the reconnected socket rejoins the interview room).
   */
  private requireSession(client: Socket): string | null {
    const data = client.data as SocketData;
    if (!data.userId) {
      client.emit('error', wsError('FORBIDDEN', 'Unauthorized'));
      return null;
    }
    if (data.exp && Date.now() >= data.exp * 1000) {
      const now = Date.now();
      if (!data.authExpiredAt || now - data.authExpiredAt >= AUTH_EXPIRED_REPEAT_MS) {
        data.authExpiredAt = now;
        client.emit('auth_expired', { message: 'Session expired — refresh and reconnect' });
      }
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

  private rateLimited(client: Socket) {
    client.emit('error', wsError('RATE_LIMITED', 'Too many requests — please wait a moment'));
  }

  /** Emits `error { message, code }`; only unexpected (INTERNAL) failures log a stack. */
  private emitError(client: Socket, event: string, err: unknown) {
    const payload = toWsError(err);
    const message = err instanceof Error ? err.message : String(err);
    if (payload.code === 'INTERNAL') {
      this.logger.error(`${event} error: ${message}`, err instanceof Error ? err.stack : undefined);
    } else {
      this.logger.warn(`${event} failed [${payload.code}]: ${message}`);
    }
    client.emit('error', payload);
  }

  /**
   * Records that this socket's user owns the interview and (re)joins its room —
   * the room is where turn results are emitted, so a socket that reconnected
   * mid-turn receives them after its first event for the interview.
   */
  private markOwned(client: Socket, interviewId: string) {
    const data = client.data as SocketData;
    (data.ownedInterviews ??= new Map<string, number>()).set(interviewId, Date.now());
    client.join(roomOf(interviewId));
  }

  /** Emits a turn result to every socket of the interview (see markOwned). */
  private emitToInterview(interviewId: string, event: string, payload: Record<string, unknown>) {
    this.server.to(roomOf(interviewId)).emit(event, payload);
  }

  /** Emits the evaluation, then either the next question or the final feedback. */
  private async emitAnswerResult(interviewId: string, userId: string, result: ProcessAnswerResult) {
    this.emitToInterview(interviewId, 'ai_response', {
      interviewId,
      response: result.aiResponse,
      audioBase64: result.responseAudioBase64,
      words: result.responseWords,
    });

    if (!result.isComplete) {
      this.emitToInterview(interviewId, 'ai_question', {
        interviewId,
        question: result.nextQuestion,
        audioBase64: result.audioBase64,
        words: result.words,
      });
      return;
    }

    try {
      const feedback = await this.generateFeedbackUseCase.execute({ interviewId, userId });
      this.emitToInterview(interviewId, 'final_feedback', { interviewId, feedback });
    } catch (err) {
      // All answers are already persisted — the client can retry via
      // REST POST /interviews/:id/feedback (idempotent).
      this.logger.error(`feedback generation failed: ${(err as Error).message}`, (err as Error).stack);
      this.emitToInterview(interviewId, 'feedback_failed', { interviewId, message: (err as Error).message });
    }
  }

  /**
   * Whether frames for this interview should be processed. Ownership/state is
   * re-verified at most every VISION_RECHECK_MS; interviews that are not in
   * progress (or not owned) are remembered and dropped silently.
   */
  private async acceptsVision(client: Socket, interviewId: string, userId: string): Promise<boolean> {
    const data = client.data as SocketData;
    if (data.ignoredVision?.has(interviewId)) return false;
    const verifiedAt = data.ownedInterviews?.get(interviewId);
    if (verifiedAt !== undefined && Date.now() - verifiedAt < VISION_RECHECK_MS) return true;

    const ignore = () => {
      (data.ignoredVision ??= new Set<string>()).add(interviewId);
      data.ownedInterviews?.delete(interviewId);
      return false;
    };
    try {
      const interview = await this.processAnswerUseCase.loadOwnedInterview(interviewId, userId);
      if (interview.status !== InterviewStatus.IN_PROGRESS) return ignore();
    } catch (err) {
      const { code } = toWsError(err);
      if (code === 'FORBIDDEN' || code === 'NOT_FOUND') return ignore();
      throw err;
    }
    this.markOwned(client, interviewId);
    return true;
  }

  // ── start_interview ─────────────────────────────────────────────────────────
  @SubscribeMessage('start_interview')
  async handleStartInterview(
    @MessageBody() data: WsStartInterviewDto,
    @ConnectedSocket() client: Socket,
  ) {
    const userId = this.requireSession(client);
    if (!userId) return;
    if (!this.consume(client, 'start')) return this.rateLimited(client);

    try {
      const result = await this.startInterviewUseCase.execute({ ...data, userId });

      this.markOwned(client, result.interview.id);
      this.emitToInterview(result.interview.id, 'ai_question', {
        interviewId: result.interview.id,
        question: result.firstQuestion,
        audioBase64: result.audioBase64,
        words: result.words,
        interviewer: result.interview.interviewer,
      });
    } catch (err) {
      this.emitError(client, 'start_interview', err);
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
    if (!this.consume(client, 'answer')) return this.rateLimited(client);

    try {
      const result = await this.processAnswerUseCase.execute({ ...data, userId });
      // execute() verified ownership — only now may this socket join the room
      this.markOwned(client, data.interviewId);
      await this.emitAnswerResult(data.interviewId, userId, result);
    } catch (err) {
      this.emitError(client, 'user_answer', err);
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
    if (!this.consume(client, 'answer')) return this.rateLimited(client);

    try {
      // Verify ownership/state BEFORE spending STT time, and transcribe in the
      // interview's own language rather than a client-supplied one.
      const interview = await this.processAnswerUseCase.loadAnswerableInterview(data.interviewId, userId);
      this.markOwned(client, interview.id);

      const audioBuffer = Buffer.from(data.audioBase64, 'base64');
      const transcript = (await this.sttService.transcribe(audioBuffer, data.mimeType, interview.language)).trim();

      if (!transcript) {
        client.emit('error', wsError(
          'EMPTY_TRANSCRIPT',
          interview.language === 'en'
            ? 'Could not understand the audio — please try again'
            : 'Não foi possível entender o áudio — tente novamente',
        ));
        return;
      }

      this.emitToInterview(data.interviewId, 'transcript', { interviewId: data.interviewId, text: transcript });

      const result = await this.processAnswerUseCase.execute({
        interviewId: data.interviewId,
        answer: transcript,
        userId,
        visionMetrics: data.visionMetrics,
      });

      await this.emitAnswerResult(data.interviewId, userId, result);
    } catch (err) {
      this.emitError(client, 'audio_answer', err);
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
    if (!data.metrics && !data.frameBase64) return;

    try {
      // The interview id doubles as the vision session id — only handle frames
      // for in-progress interviews this user owns; anything else is dropped
      // silently (no log spam, no vision call).
      if (!(await this.acceptsVision(client, data.interviewId, userId))) return;

      // If the client already computed metrics client-side, emit them directly
      if (data.metrics) {
        client.emit('vision_result', { interviewId: data.interviewId, metrics: data.metrics });
        return;
      }

      // Otherwise process the raw frame server-side
      if (!data.frameBase64) return;
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
