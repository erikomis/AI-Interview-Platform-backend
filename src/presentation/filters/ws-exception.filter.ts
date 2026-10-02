import { ArgumentsHost, Catch, Logger } from '@nestjs/common';
import { BaseWsExceptionFilter } from '@nestjs/websockets';
import { Socket } from 'socket.io';
import { toWsError } from './ws-error';

/**
 * Surfaces any exception escaping a gateway handler (validation errors, guards,
 * unexpected throws) with the same `error` event shape the handlers emit
 * themselves: `{ message: string, code: WsErrorCode }`. Nest's default emits
 * `exception` instead.
 */
@Catch()
export class WsErrorFilter extends BaseWsExceptionFilter {
  private readonly logger = new Logger(WsErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const client = host.switchToWs().getClient<Socket>();
    const payload = toWsError(exception);
    if (payload.code === 'INTERNAL') {
      this.logger.error('Unhandled WS exception', exception instanceof Error ? exception.stack : String(exception));
    }
    client.emit('error', payload);
  }
}
