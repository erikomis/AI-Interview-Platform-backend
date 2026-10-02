import { ConflictException, ForbiddenException } from '@nestjs/common';
import { InterviewGateway } from './interview.gateway';
import { InterviewStatus } from '../../domain/value-objects/interview-status.vo';
import { AIUnavailableError } from '../../domain/interfaces/ai.interface';
import { TranscriptionFailedError } from '../../domain/interfaces/stt.interface';
import {
  AllQuestionsAnsweredException,
  InterviewNotInProgressException,
} from '../../application/errors/interview.errors';

// ── Helpers ──────────────────────────────────────────────────────────────────

const INTERVIEW_ID = '6f1c1f3e-8d7a-4c2b-9f5e-2a1b3c4d5e6f';
const USER_ID = 'user-abc';

const makeClient = (data: Record<string, unknown> = {}) => ({
  id: 'sock-1',
  data: { userId: USER_ID, email: 'a@b.c', exp: Math.floor(Date.now() / 1000) + 600, ...data },
  emit: jest.fn(),
  join: jest.fn(),
  disconnect: jest.fn(),
  handshake: { headers: {} as Record<string, string> },
});

const makeDeps = () => ({
  start: { execute: jest.fn() },
  answer: {
    execute: jest.fn().mockResolvedValue({ aiResponse: 'Nice', nextQuestion: 'Q2?', audioBase64: null, isComplete: false }),
    loadAnswerableInterview: jest.fn().mockResolvedValue({ id: INTERVIEW_ID, language: 'en' }),
    loadOwnedInterview: jest.fn().mockResolvedValue({ id: INTERVIEW_ID, status: InterviewStatus.IN_PROGRESS }),
  },
  feedback: { execute: jest.fn() },
  jwt: { verify: jest.fn() },
  config: { get: jest.fn().mockReturnValue('secret') },
  stt: { transcribe: jest.fn().mockResolvedValue('my spoken answer') },
  vision: { processFrame: jest.fn(), endSession: jest.fn() },
});

/** Fake namespace: records room emits as [room, event, payload]. */
const makeServer = () => {
  const roomEmits: Array<[string, string, unknown]> = [];
  return {
    roomEmits,
    to: jest.fn((room: string) => ({
      emit: (event: string, payload: unknown) => roomEmits.push([room, event, payload]),
    })),
  };
};

let server: ReturnType<typeof makeServer>;

const makeSut = (d = makeDeps()) => {
  const sut = new InterviewGateway(
    d.start as any, d.answer as any, d.feedback as any, d.jwt as any,
    d.config as any, d.stt as any, d.vision as any,
  );
  server = makeServer();
  sut.server = server as any;
  return sut;
};

/** Events emitted directly on the socket */
const emitted = (client: ReturnType<typeof makeClient>, event: string) =>
  client.emit.mock.calls.filter(([e]) => e === event).map(([, payload]) => payload);

/** Events emitted to the interview room */
const roomEmitted = (event: string, room = `interview:${INTERVIEW_ID}`) =>
  server.roomEmits.filter(([r, e]) => r === room && e === event).map(([, , payload]) => payload);

// ── Tests ────────────────────────────────────────────────────────────────────

describe('InterviewGateway', () => {
  describe('handshake middleware', () => {
    const runMiddleware = (sut: InterviewGateway, client: ReturnType<typeof makeClient>) => {
      let mw: (s: unknown, next: (err?: Error) => void) => void = () => undefined;
      sut.afterInit({ use: (fn: typeof mw) => { mw = fn; } } as any);
      const next = jest.fn();
      mw(client, next);
      return next;
    };

    it('rejects a missing cookie with connect_error "unauthorized"', () => {
      const next = runMiddleware(makeSut(), makeClient({ userId: undefined }));
      expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
      expect(next.mock.calls[0][0].message).toBe('unauthorized');
    });

    it('rejects an invalid token with "unauthorized"', () => {
      const d = makeDeps();
      d.jwt.verify.mockImplementation(() => { throw new Error('bad sig'); });
      const client = makeClient();
      client.handshake.headers.cookie = 'foo=1; access_token=bad';
      const next = runMiddleware(makeSut(d), client);
      expect(next.mock.calls[0][0].message).toBe('unauthorized');
    });

    it('accepts a valid token and stores userId + exp on the socket', () => {
      const d = makeDeps();
      d.jwt.verify.mockReturnValue({ sub: 'u-1', email: 'x@y.z', exp: 123 });
      const client = makeClient({ userId: undefined, exp: undefined });
      client.handshake.headers.cookie = 'access_token=good';
      const next = runMiddleware(makeSut(d), client);
      expect(next).toHaveBeenCalledWith();
      expect(client.data).toMatchObject({ userId: 'u-1', exp: 123 });
    });
  });

  it('emits session_info with the token expiry on connect', () => {
    const client = makeClient({ exp: 1234567890 });
    makeSut().handleConnection(client as any);
    expect(emitted(client, 'session_info')).toEqual([{ exp: 1234567890 }]);
  });

  describe('expired access token', () => {
    it('emits auth_expired and drops the event WITHOUT disconnecting', async () => {
      const d = makeDeps();
      const client = makeClient({ exp: Math.floor(Date.now() / 1000) - 1 });
      await makeSut(d).handleUserAnswer({ interviewId: INTERVIEW_ID, answer: 'x' }, client as any);

      expect(emitted(client, 'auth_expired')).toHaveLength(1);
      expect(client.disconnect).not.toHaveBeenCalled();
      expect(d.answer.execute).not.toHaveBeenCalled();
    });

    it('does not flood auth_expired for a burst of events', async () => {
      const d = makeDeps();
      const client = makeClient({ exp: Math.floor(Date.now() / 1000) - 1 });
      const sut = makeSut(d);
      for (let i = 0; i < 5; i++) {
        await sut.handleVisionMetrics({ interviewId: INTERVIEW_ID, frameBase64: 'AAAA' }, client as any);
      }
      expect(emitted(client, 'auth_expired')).toHaveLength(1);
      expect(d.vision.processFrame).not.toHaveBeenCalled();
    });

    it('still delivers the result of a turn that was in flight when the token expired', async () => {
      const d = makeDeps();
      let finish: (v: unknown) => void = () => undefined;
      d.answer.execute.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
      const client = makeClient();
      const sut = makeSut(d);

      const pending = sut.handleUserAnswer({ interviewId: INTERVIEW_ID, answer: 'x' }, client as any);
      // Token expires mid-turn: later events are refused...
      client.data.exp = Math.floor(Date.now() / 1000) - 1;
      await sut.handleUserAnswer({ interviewId: INTERVIEW_ID, answer: 'y' }, client as any);
      expect(emitted(client, 'auth_expired')).toHaveLength(1);

      // ...but the in-flight answer is still emitted to the interview room
      finish({ aiResponse: 'Good', nextQuestion: 'Q2?', audioBase64: null, responseAudioBase64: null, isComplete: false });
      await pending;
      expect(client.disconnect).not.toHaveBeenCalled();
      expect(roomEmitted('ai_response')).toHaveLength(1);
      expect(roomEmitted('ai_question')).toEqual([expect.objectContaining({ question: 'Q2?' })]);
    });
  });

  describe('interview room', () => {
    it('joins the room and emits the answer result there', async () => {
      const d = makeDeps();
      const client = makeClient();
      await makeSut(d).handleUserAnswer({ interviewId: INTERVIEW_ID, answer: 'x' }, client as any);

      expect(client.join).toHaveBeenCalledWith(`interview:${INTERVIEW_ID}`);
      expect(roomEmitted('ai_response')).toEqual([{ interviewId: INTERVIEW_ID, response: 'Nice', audioBase64: undefined }]);
      expect(roomEmitted('ai_question')).toEqual([{ interviewId: INTERVIEW_ID, question: 'Q2?', audioBase64: null }]);
      expect(emitted(client, 'ai_response')).toHaveLength(0);
    });

    it('a reconnected socket rejoins the room on its first owned event', async () => {
      const d = makeDeps();
      const reconnected = makeClient({ ownedInterviews: undefined });
      await makeSut(d).handleVisionMetrics(
        { interviewId: INTERVIEW_ID, metrics: { eye_contact: 1, stress_level: 0, confidence: 1 } },
        reconnected as any,
      );

      expect(d.answer.loadOwnedInterview).toHaveBeenCalledWith(INTERVIEW_ID, USER_ID);
      expect(reconnected.join).toHaveBeenCalledWith(`interview:${INTERVIEW_ID}`);
    });

    it('does not join the room when the ownership check fails', async () => {
      const d = makeDeps();
      d.answer.execute.mockRejectedValue(new ForbiddenException('Access denied to this interview'));
      const client = makeClient();
      await makeSut(d).handleUserAnswer({ interviewId: INTERVIEW_ID, answer: 'x' }, client as any);

      expect(client.join).not.toHaveBeenCalled();
      expect(emitted(client, 'error')).toEqual([{ message: 'Access denied to this interview', code: 'FORBIDDEN' }]);
    });

    it('starts an interview, joins its room and emits the first question with the persona', async () => {
      const d = makeDeps();
      d.start.execute.mockResolvedValue({
        interview: { id: INTERVIEW_ID, interviewer: 'female' },
        firstQuestion: 'Hi, I am Sofia. Q1?',
        audioBase64: null,
      });
      const client = makeClient();
      await makeSut(d).handleStartInterview(
        { candidateId: 'Ana', role: 'Dev', interviewer: 'female' },
        client as any,
      );

      expect(d.start.execute).toHaveBeenCalledWith(expect.objectContaining({ interviewer: 'female', userId: USER_ID }));
      expect(client.join).toHaveBeenCalledWith(`interview:${INTERVIEW_ID}`);
      expect(roomEmitted('ai_question')).toEqual([
        { interviewId: INTERVIEW_ID, question: 'Hi, I am Sofia. Q1?', audioBase64: null, interviewer: 'female' },
      ]);
    });
  });

  it('emits feedback_failed when feedback generation fails after the last answer', async () => {
    const d = makeDeps();
    d.answer.execute.mockResolvedValue({ aiResponse: 'ok', nextQuestion: null, audioBase64: null, isComplete: true });
    d.feedback.execute.mockRejectedValue(new Error('Ollama down'));
    const client = makeClient();
    await makeSut(d).handleUserAnswer({ interviewId: INTERVIEW_ID, answer: 'x' }, client as any);

    expect(roomEmitted('ai_response')).toHaveLength(1);
    expect(roomEmitted('feedback_failed')).toEqual([{ interviewId: INTERVIEW_ID, message: 'Ollama down' }]);
    expect(emitted(client, 'error')).toHaveLength(0);
  });

  it('emits final_feedback to the room after the last answer', async () => {
    const d = makeDeps();
    d.answer.execute.mockResolvedValue({ aiResponse: 'ok', nextQuestion: null, audioBase64: null, isComplete: true });
    d.feedback.execute.mockResolvedValue({ overall: 7 });
    const client = makeClient();
    await makeSut(d).handleUserAnswer({ interviewId: INTERVIEW_ID, answer: 'x' }, client as any);

    expect(roomEmitted('final_feedback')).toEqual([{ interviewId: INTERVIEW_ID, feedback: { overall: 7 } }]);
  });

  it('rate-limits answers to one per 2 seconds', async () => {
    const d = makeDeps();
    const client = makeClient();
    const sut = makeSut(d);
    await sut.handleUserAnswer({ interviewId: INTERVIEW_ID, answer: 'a' }, client as any);
    await sut.handleUserAnswer({ interviewId: INTERVIEW_ID, answer: 'b' }, client as any);

    expect(d.answer.execute).toHaveBeenCalledTimes(1);
    expect(emitted(client, 'error')[0]).toEqual({ message: expect.stringMatching(/too many/i), code: 'RATE_LIMITED' });
  });

  describe('error codes', () => {
    it.each([
      ['BUSY', new ConflictException('An answer for this interview is already being processed')],
      ['NOT_IN_PROGRESS', new InterviewNotInProgressException()],
      ['ALL_ANSWERED', new AllQuestionsAnsweredException()],
      ['AI_UNAVAILABLE', new AIUnavailableError('Ollama unreachable: ECONNREFUSED')],
      ['INTERNAL', new Error('boom')],
    ])('maps failures to code %s', async (code, error) => {
      const d = makeDeps();
      d.answer.execute.mockRejectedValue(error);
      const client = makeClient();
      await makeSut(d).handleUserAnswer({ interviewId: INTERVIEW_ID, answer: 'x' }, client as any);

      const [payload] = emitted(client, 'error') as Array<{ code: string; message: string }>;
      expect(payload.code).toBe(code);
      expect(payload.message).toEqual(expect.any(String));
    });

    it('never leaks internal error details', async () => {
      const d = makeDeps();
      d.answer.execute.mockRejectedValue(new AIUnavailableError('Ollama error 500: secret stack'));
      const client = makeClient();
      await makeSut(d).handleUserAnswer({ interviewId: INTERVIEW_ID, answer: 'x' }, client as any);
      expect(JSON.stringify(emitted(client, 'error'))).not.toContain('secret');
    });
  });

  describe('audio_answer', () => {
    it('checks ownership before STT and transcribes in the interview language', async () => {
      const d = makeDeps();
      const client = makeClient();
      await makeSut(d).handleAudioAnswer({ interviewId: INTERVIEW_ID, audioBase64: 'AAAA' }, client as any);

      expect(d.answer.loadAnswerableInterview).toHaveBeenCalledWith(INTERVIEW_ID, USER_ID);
      expect(d.stt.transcribe).toHaveBeenCalledWith(expect.any(Buffer), undefined, 'en');
      expect(client.join).toHaveBeenCalledWith(`interview:${INTERVIEW_ID}`);
      expect(roomEmitted('transcript')).toEqual([{ interviewId: INTERVIEW_ID, text: 'my spoken answer' }]);
    });

    it('does not run STT when the ownership check fails', async () => {
      const d = makeDeps();
      d.answer.loadAnswerableInterview.mockRejectedValue(new ForbiddenException('Access denied to this interview'));
      const client = makeClient();
      await makeSut(d).handleAudioAnswer({ interviewId: INTERVIEW_ID, audioBase64: 'AAAA' }, client as any);

      expect(d.stt.transcribe).not.toHaveBeenCalled();
      expect(emitted(client, 'error')).toEqual([{ message: 'Access denied to this interview', code: 'FORBIDDEN' }]);
    });

    it('emits an error and skips processing on an empty transcript', async () => {
      const d = makeDeps();
      d.stt.transcribe.mockResolvedValue('   ');
      const client = makeClient();
      await makeSut(d).handleAudioAnswer({ interviewId: INTERVIEW_ID, audioBase64: 'AAAA' }, client as any);

      expect(d.answer.execute).not.toHaveBeenCalled();
      expect(emitted(client, 'error')).toEqual([{ message: expect.any(String), code: 'EMPTY_TRANSCRIPT' }]);
    });

    it('reports TRANSCRIPTION_FAILED when the STT backend fails', async () => {
      const d = makeDeps();
      d.stt.transcribe.mockRejectedValue(new TranscriptionFailedError());
      const client = makeClient();
      await makeSut(d).handleAudioAnswer({ interviewId: INTERVIEW_ID, audioBase64: 'AAAA' }, client as any);

      expect(d.answer.execute).not.toHaveBeenCalled();
      expect(emitted(client, 'error')).toEqual([{ message: 'Failed to transcribe audio', code: 'TRANSCRIPTION_FAILED' }]);
    });
  });

  it('forwards frames to the vision service with the interview id as session id', async () => {
    const d = makeDeps();
    d.vision.processFrame.mockResolvedValue({ eye_contact: 1, stress_level: 0, confidence: 1 });
    const client = makeClient();
    await makeSut(d).handleVisionMetrics({ interviewId: INTERVIEW_ID, frameBase64: 'AAAA' }, client as any);

    expect(d.vision.processFrame).toHaveBeenCalledWith(expect.any(Buffer), INTERVIEW_ID);
    expect(emitted(client, 'vision_result')).toHaveLength(1);
  });

  it('silently ignores frames for an interview that is not in progress (checked once)', async () => {
    const d = makeDeps();
    d.answer.loadOwnedInterview.mockResolvedValue({ id: INTERVIEW_ID, status: InterviewStatus.COMPLETED });
    const client = makeClient();
    const sut = makeSut(d);
    const warn = jest.spyOn((sut as any).logger, 'warn');

    // Spaced past the rate limit so each frame reaches the state check
    const t0 = Date.now();
    const now = jest.spyOn(Date, 'now');
    for (let i = 0; i < 3; i++) {
      now.mockReturnValue(t0 + i * 1000);
      await sut.handleVisionMetrics({ interviewId: INTERVIEW_ID, frameBase64: 'AAAA' }, client as any);
    }
    now.mockRestore();

    expect(d.answer.loadOwnedInterview).toHaveBeenCalledTimes(1);
    expect(d.vision.processFrame).not.toHaveBeenCalled();
    expect(emitted(client, 'vision_result')).toHaveLength(0);
    expect(emitted(client, 'error')).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });
});
