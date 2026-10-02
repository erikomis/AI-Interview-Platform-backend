import { InterviewGateway } from './interview.gateway';

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
  },
  feedback: { execute: jest.fn() },
  jwt: { verify: jest.fn() },
  config: { get: jest.fn().mockReturnValue('secret') },
  stt: { transcribe: jest.fn().mockResolvedValue('my spoken answer') },
  vision: { processFrame: jest.fn(), endSession: jest.fn() },
});

const makeSut = (d = makeDeps()) =>
  new InterviewGateway(
    d.start as any, d.answer as any, d.feedback as any, d.jwt as any,
    d.config as any, d.stt as any, d.vision as any,
  );

const emitted = (client: ReturnType<typeof makeClient>, event: string) =>
  client.emit.mock.calls.filter(([e]) => e === event).map(([, payload]) => payload);

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

  it('emits auth_expired and disconnects when the token has expired', async () => {
    const d = makeDeps();
    const client = makeClient({ exp: Math.floor(Date.now() / 1000) - 1 });
    await makeSut(d).handleUserAnswer({ interviewId: INTERVIEW_ID, answer: 'x' }, client as any);

    expect(emitted(client, 'auth_expired')).toHaveLength(1);
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(d.answer.execute).not.toHaveBeenCalled();
  });

  it('emits feedback_failed when feedback generation fails after the last answer', async () => {
    const d = makeDeps();
    d.answer.execute.mockResolvedValue({ aiResponse: 'ok', nextQuestion: null, audioBase64: null, isComplete: true });
    d.feedback.execute.mockRejectedValue(new Error('Ollama down'));
    const client = makeClient();
    await makeSut(d).handleUserAnswer({ interviewId: INTERVIEW_ID, answer: 'x' }, client as any);

    expect(emitted(client, 'ai_response')).toHaveLength(1);
    expect(emitted(client, 'feedback_failed')).toEqual([{ interviewId: INTERVIEW_ID, message: 'Ollama down' }]);
    expect(emitted(client, 'error')).toHaveLength(0);
  });

  it('rate-limits answers to one per 2 seconds', async () => {
    const d = makeDeps();
    const client = makeClient();
    const sut = makeSut(d);
    await sut.handleUserAnswer({ interviewId: INTERVIEW_ID, answer: 'a' }, client as any);
    await sut.handleUserAnswer({ interviewId: INTERVIEW_ID, answer: 'b' }, client as any);

    expect(d.answer.execute).toHaveBeenCalledTimes(1);
    expect(emitted(client, 'error')[0]).toEqual({ message: expect.stringMatching(/too many/i) });
  });

  describe('audio_answer', () => {
    it('checks ownership before STT and transcribes in the interview language', async () => {
      const d = makeDeps();
      const client = makeClient();
      await makeSut(d).handleAudioAnswer({ interviewId: INTERVIEW_ID, audioBase64: 'AAAA' }, client as any);

      expect(d.answer.loadAnswerableInterview).toHaveBeenCalledWith(INTERVIEW_ID, USER_ID);
      expect(d.stt.transcribe).toHaveBeenCalledWith(expect.any(Buffer), undefined, 'en');
      expect(emitted(client, 'transcript')).toEqual([{ interviewId: INTERVIEW_ID, text: 'my spoken answer' }]);
    });

    it('does not run STT when the ownership check fails', async () => {
      const d = makeDeps();
      d.answer.loadAnswerableInterview.mockRejectedValue(new Error('Access denied to this interview'));
      const client = makeClient();
      await makeSut(d).handleAudioAnswer({ interviewId: INTERVIEW_ID, audioBase64: 'AAAA' }, client as any);

      expect(d.stt.transcribe).not.toHaveBeenCalled();
      expect(emitted(client, 'error')).toEqual([{ message: 'Access denied to this interview' }]);
    });

    it('emits an error and skips processing on an empty transcript', async () => {
      const d = makeDeps();
      d.stt.transcribe.mockResolvedValue('   ');
      const client = makeClient();
      await makeSut(d).handleAudioAnswer({ interviewId: INTERVIEW_ID, audioBase64: 'AAAA' }, client as any);

      expect(d.answer.execute).not.toHaveBeenCalled();
      expect(emitted(client, 'error')).toHaveLength(1);
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
});
