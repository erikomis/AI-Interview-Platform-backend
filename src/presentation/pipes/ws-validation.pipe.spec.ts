import { WsException } from '@nestjs/websockets';
import { WsValidationPipe } from './ws-validation.pipe';
import { WsUserAnswerDto, WsStartInterviewDto } from '../../application/dtos/interview.dto';

const PAYLOAD = 3; // WsParamtype.PAYLOAD
const SOCKET = 0;  // WsParamtype.SOCKET

describe('WsValidationPipe', () => {
  const pipe = new WsValidationPipe();
  const meta = (metatype: unknown, type: number) => ({ metatype, type }) as any;

  it('passes the socket param through untouched', async () => {
    class FakeSocket { id = 'abc'; }
    const socket = new FakeSocket();
    await expect(pipe.transform(socket, meta(FakeSocket, SOCKET))).resolves.toBe(socket);
  });

  it('accepts a valid payload and strips unknown fields', async () => {
    const out = (await pipe.transform(
      {
        interviewId: '6f1c1f3e-8d7a-4c2b-9f5e-2a1b3c4d5e6f',
        answer: 'hello',
        visionMetrics: { eye_contact: 0.5, stress_level: 0.1, confidence: 0.9, face_visible: true },
        evil: 'x',
      },
      meta(WsUserAnswerDto, PAYLOAD),
    )) as Record<string, unknown>;

    expect(out).toBeInstanceOf(WsUserAnswerDto);
    expect(out).not.toHaveProperty('evil');
  });

  it('throws WsException for an invalid uuid / out-of-range metrics', async () => {
    await expect(
      pipe.transform(
        { interviewId: 'nope', answer: 'x', visionMetrics: { eye_contact: 2, stress_level: 0, confidence: 0 } },
        meta(WsUserAnswerDto, PAYLOAD),
      ),
    ).rejects.toBeInstanceOf(WsException);
  });

  it('rejects an unsupported language on start_interview', async () => {
    await expect(
      pipe.transform({ candidateId: 'John', role: 'Dev', language: 'fr' }, meta(WsStartInterviewDto, PAYLOAD)),
    ).rejects.toBeInstanceOf(WsException);
  });

  it('rejects a missing payload', async () => {
    await expect(pipe.transform(undefined, meta(WsUserAnswerDto, PAYLOAD))).rejects.toBeInstanceOf(WsException);
  });
});
