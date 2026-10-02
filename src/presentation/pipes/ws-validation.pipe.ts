import { ArgumentMetadata, ValidationError, ValidationPipe } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';

// WsParamtype.PAYLOAD (from @nestjs/websockets/enums) — not re-exported publicly
const WS_PAYLOAD_PARAM = 3;

/** Flattens nested class-validator errors into "field.child: constraint" strings. */
function flatten(errors: ValidationError[], parent = ''): string[] {
  return errors.flatMap((e) => {
    const path = parent ? `${parent}.${e.property}` : e.property;
    const own = Object.values(e.constraints ?? {}).map((msg) => (parent ? `${path}: ${msg}` : msg));
    return [...own, ...flatten(e.children ?? [], path)];
  });
}

/**
 * ValidationPipe for gateways. Two differences from the HTTP one:
 *  - validates only @MessageBody() — a plain ValidationPipe would also run
 *    plainToClass over the @ConnectedSocket() instance and replace it;
 *  - throws WsException so the gateway filter can emit it as an `error` event.
 */
export class WsValidationPipe extends ValidationPipe {
  constructor() {
    super({
      whitelist: true,
      transform: true,
      exceptionFactory: (errors: ValidationError[]) =>
        new WsException(`Invalid payload: ${flatten(errors).join('; ')}`),
    });
  }

  protected toValidate(metadata: ArgumentMetadata): boolean {
    if ((metadata.type as unknown) !== WS_PAYLOAD_PARAM) return false;
    return super.toValidate(metadata);
  }

  async transform(value: unknown, metadata: ArgumentMetadata): Promise<unknown> {
    // Non-payload params (the socket) pass through untouched
    if ((metadata.type as unknown) !== WS_PAYLOAD_PARAM) return value;
    // A missing/non-object payload must still be rejected, not silently accepted
    if (value === null || typeof value !== 'object') {
      throw new WsException('Invalid payload: expected an object');
    }
    return super.transform(value, metadata);
  }
}
