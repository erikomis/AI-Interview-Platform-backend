import { ConflictException, ForbiddenException, HttpException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import {
  AllQuestionsAnsweredException,
  InterviewBusyException,
  InterviewNotInProgressException,
} from '../../application/errors/interview.errors';
import { AIUnavailableError } from '../../domain/interfaces/ai.interface';
import { TranscriptionFailedError } from '../../domain/interfaces/stt.interface';

/** Stable, machine-readable codes carried by every WebSocket `error` event. */
export type WsErrorCode =
  | 'RATE_LIMITED'
  | 'BUSY'
  | 'NOT_IN_PROGRESS'
  | 'ALL_ANSWERED'
  | 'INVALID_PAYLOAD'
  | 'EMPTY_TRANSCRIPT'
  | 'TRANSCRIPTION_FAILED'
  | 'AI_UNAVAILABLE'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INTERNAL';

export interface WsErrorPayload {
  message: string;
  code: WsErrorCode;
}

export const wsError = (code: WsErrorCode, message: string): WsErrorPayload => ({ message, code });

/** Maps anything thrown by a handler (or a pipe) to the `error` event payload. */
export function toWsError(exception: unknown): WsErrorPayload {
  if (exception instanceof WsException) {
    const err = exception.getError();
    if (typeof err === 'string') return wsError('INVALID_PAYLOAD', err);
    if (err && typeof err === 'object' && 'message' in err) {
      return wsError('INVALID_PAYLOAD', String((err as { message: unknown }).message));
    }
    return wsError('INVALID_PAYLOAD', 'Invalid request');
  }
  if (exception instanceof InterviewNotInProgressException) return wsError('NOT_IN_PROGRESS', exception.message);
  if (exception instanceof AllQuestionsAnsweredException) return wsError('ALL_ANSWERED', exception.message);
  if (exception instanceof InterviewBusyException || exception instanceof ConflictException) {
    return wsError('BUSY', exception.message);
  }
  if (exception instanceof ForbiddenException || exception instanceof UnauthorizedException) {
    return wsError('FORBIDDEN', exception.message);
  }
  if (exception instanceof NotFoundException) return wsError('NOT_FOUND', exception.message);
  if (exception instanceof HttpException && exception.getStatus() === 400) {
    return wsError('INVALID_PAYLOAD', exception.message);
  }
  if (exception instanceof TranscriptionFailedError) return wsError('TRANSCRIPTION_FAILED', exception.message);
  if (exception instanceof AIUnavailableError) {
    // The raw Ollama error (URL, response body) stays in the server logs
    return wsError('AI_UNAVAILABLE', 'The AI interviewer is unavailable right now — please try again shortly');
  }
  return wsError('INTERNAL', 'Internal server error');
}
