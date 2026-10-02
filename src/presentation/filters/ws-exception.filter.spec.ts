import { BadRequestException, NotFoundException } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { WsErrorFilter } from './ws-exception.filter';

const hostFor = (client: { emit: jest.Mock }) =>
  ({ switchToWs: () => ({ getClient: () => client }) }) as any;

describe('WsErrorFilter', () => {
  const run = (exception: unknown) => {
    const client = { emit: jest.fn() };
    new WsErrorFilter().catch(exception, hostFor(client));
    return client.emit.mock.calls;
  };

  it('emits validation failures as INVALID_PAYLOAD', () => {
    expect(run(new WsException('Invalid payload: role should not be empty'))).toEqual([
      ['error', { message: 'Invalid payload: role should not be empty', code: 'INVALID_PAYLOAD' }],
    ]);
    expect(run(new BadRequestException('bad'))).toEqual([['error', { message: 'bad', code: 'INVALID_PAYLOAD' }]]);
  });

  it('maps NotFoundException to NOT_FOUND', () => {
    expect(run(new NotFoundException('Interview x not found'))).toEqual([
      ['error', { message: 'Interview x not found', code: 'NOT_FOUND' }],
    ]);
  });

  it('hides unexpected errors behind INTERNAL', () => {
    expect(run(new Error('db password is hunter2'))).toEqual([
      ['error', { message: 'Internal server error', code: 'INTERNAL' }],
    ]);
  });
});
