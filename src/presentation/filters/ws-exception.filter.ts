import { ArgumentsHost, Catch, HttpException, Logger } from '@nestjs/common';
import { BaseWsExceptionFilter, WsException } from '@nestjs/websockets';
import { Socket } from 'socket.io';

/**
 * Surfaces any exception escaping a gateway handler (validation errors, guards,
 * unexpected throws) with the same `error` event shape the handlers emit
 * themselves: `{ message: string }`. Nest's default emits `exception` instead.
 */
@Catch()
export class WsErrorFilter extends BaseWsExceptionFilter {
  private readonly logger = new Logger(WsErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const client = host.switchToWs().getClient<Socket>();
    client.emit('error', { message: this.messageOf(exception) });
  }

  private messageOf(exception: unknown): string {
    if (exception instanceof WsException) {
      const err = exception.getError();
      if (typeof err === 'string') return err;
      if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message);
      return 'Invalid request';
    }
    if (exception instanceof HttpException) return exception.message;
    this.logger.error('Unhandled WS exception', exception instanceof Error ? exception.stack : String(exception));
    return 'Internal server error';
  }
}
