import { Interview, InterviewFeedback } from './interview.entity';
import { InterviewStatus } from '../value-objects/interview-status.vo';

const makeFeedback = (): InterviewFeedback => ({
  technical: 8,
  communication: 7,
  confidence: 8,
  clarity: 9,
  overall: 8,
  summary: 'Great performance overall',
  strengths: ['Problem solving', 'Clean code'],
  improvements: ['Communication clarity'],
});

describe('Interview Entity', () => {
  const makeSut = () =>
    new Interview('John Doe', 'Software Engineer', 'en', 'mid', 'user-123');

  // ── constructor ──────────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('initialises with correct defaults', () => {
      const interview = makeSut();

      expect(interview.candidateId).toBe('John Doe');
      expect(interview.role).toBe('Software Engineer');
      expect(interview.language).toBe('en');
      expect(interview.experienceLevel).toBe('mid');
      expect(interview.userId).toBe('user-123');
      expect(interview.status).toBe(InterviewStatus.PENDING);
      expect(interview.messages).toHaveLength(0);
      expect(interview.visionMetrics).toHaveLength(0);
      expect(interview.currentQuestion).toBeNull();
      expect(interview.feedback).toBeNull();
      expect(interview.maxQuestions).toBe(10);
    });

    it('accepts custom maxQuestions', () => {
      const interview = new Interview('name', 'role', 'pt', 'junior', 'uid', 5);
      expect(interview.maxQuestions).toBe(5);
    });

    it('assigns sessionVariant in range [1, 3]', () => {
      for (let i = 0; i < 20; i++) {
        const { sessionVariant } = makeSut();
        expect(sessionVariant).toBeGreaterThanOrEqual(1);
        expect(sessionVariant).toBeLessThanOrEqual(3);
      }
    });

    it('generates unique ids per instance', () => {
      const ids = Array.from({ length: 10 }, () => makeSut().id);
      expect(new Set(ids).size).toBe(10);
    });

    it('defaults userId to a uuid when omitted', () => {
      const interview = new Interview('name', 'role');
      expect(typeof interview.userId).toBe('string');
      expect(interview.userId.length).toBeGreaterThan(0);
    });
  });

  // ── start() ─────────────────────────────────────────────────────────────────

  describe('start()', () => {
    it('transitions PENDING → IN_PROGRESS', () => {
      const interview = makeSut();
      interview.start();
      expect(interview.status).toBe(InterviewStatus.IN_PROGRESS);
    });

    it('updates updatedAt on start', () => {
      const interview = makeSut();
      const before = interview.updatedAt;
      interview.start();
      expect(interview.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });

    it('throws when already started', () => {
      const interview = makeSut();
      interview.start();
      expect(() => interview.start()).toThrow('Interview already started');
    });
  });

  // ── addMessage() ─────────────────────────────────────────────────────────────

  describe('addMessage()', () => {
    it('appends messages in order', () => {
      const interview = makeSut();
      interview.addMessage('interviewer', 'Tell me about yourself');
      interview.addMessage('candidate', 'I am a software engineer');

      expect(interview.messages).toHaveLength(2);
      expect(interview.messages[0]).toMatchObject({
        role: 'interviewer',
        content: 'Tell me about yourself',
      });
      expect(interview.messages[1]).toMatchObject({
        role: 'candidate',
        content: 'I am a software engineer',
      });
    });

    it('stores optional audioUrl', () => {
      const interview = makeSut();
      interview.addMessage('interviewer', 'Q1', 'https://cdn.audio/q1.mp3');
      expect(interview.messages[0].audioUrl).toBe('https://cdn.audio/q1.mp3');
    });

    it('each message has a timestamp', () => {
      const interview = makeSut();
      interview.addMessage('candidate', 'Answer');
      expect(interview.messages[0].timestamp).toBeInstanceOf(Date);
    });
  });

  // ── addVisionMetrics() ───────────────────────────────────────────────────────

  describe('addVisionMetrics()', () => {
    it('accumulates metrics without replacing previous ones', () => {
      const interview = makeSut();
      interview.addVisionMetrics({ eye_contact: 0.9, stress_level: 0.2, confidence: 0.8 });
      interview.addVisionMetrics({ eye_contact: 0.7, stress_level: 0.3, confidence: 0.6 });

      expect(interview.visionMetrics).toHaveLength(2);
    });
  });

  // ── getAverageVisionMetrics() ────────────────────────────────────────────────

  describe('getAverageVisionMetrics()', () => {
    it('returns null when no metrics recorded', () => {
      expect(makeSut().getAverageVisionMetrics()).toBeNull();
    });

    it('returns the single metric unchanged when only one snapshot', () => {
      const interview = makeSut();
      interview.addVisionMetrics({ eye_contact: 0.8, stress_level: 0.2, confidence: 0.9 });
      const avg = interview.getAverageVisionMetrics()!;

      expect(avg.eye_contact).toBeCloseTo(0.8);
      expect(avg.stress_level).toBeCloseTo(0.2);
      expect(avg.confidence).toBeCloseTo(0.9);
    });

    it('computes correct arithmetic mean across multiple snapshots', () => {
      const interview = makeSut();
      interview.addVisionMetrics({ eye_contact: 0.8, stress_level: 0.2, confidence: 0.9 });
      interview.addVisionMetrics({ eye_contact: 0.6, stress_level: 0.4, confidence: 0.7 });

      const avg = interview.getAverageVisionMetrics()!;
      expect(avg.eye_contact).toBeCloseTo(0.7);
      expect(avg.stress_level).toBeCloseTo(0.3);
      expect(avg.confidence).toBeCloseTo(0.8);
    });

    it('ignores frames where face_visible is false', () => {
      const interview = makeSut();
      interview.addVisionMetrics({ eye_contact: 0.8, stress_level: 0.2, confidence: 0.9, face_visible: true });
      interview.addVisionMetrics({ eye_contact: 0, stress_level: 1, confidence: 0, face_visible: false });

      const avg = interview.getAverageVisionMetrics()!;
      expect(avg.eye_contact).toBeCloseTo(0.8);
      expect(avg.stress_level).toBeCloseTo(0.2);
    });

    it('returns null when every frame lacks a visible face', () => {
      const interview = makeSut();
      interview.addVisionMetrics({ eye_contact: 0, stress_level: 0, confidence: 0, face_visible: false });
      expect(interview.getAverageVisionMetrics()).toBeNull();
    });

    it('skips non-finite values instead of producing NaN', () => {
      const interview = makeSut();
      interview.addVisionMetrics({ eye_contact: 0.6, stress_level: 0.2, confidence: 0.5 });
      interview.addVisionMetrics({ eye_contact: NaN, stress_level: 0.4, confidence: 0.7 });

      const avg = interview.getAverageVisionMetrics()!;
      expect(avg.eye_contact).toBeCloseTo(0.6);
      expect(avg.stress_level).toBeCloseTo(0.3);
      expect(Number.isNaN(avg.confidence)).toBe(false);
    });
  });

  // ── setCurrentQuestion() ─────────────────────────────────────────────────────

  describe('setCurrentQuestion()', () => {
    it('updates currentQuestion', () => {
      const interview = makeSut();
      interview.setCurrentQuestion('What is the time complexity of quicksort?');
      expect(interview.currentQuestion).toBe('What is the time complexity of quicksort?');
    });
  });

  // ── complete() ───────────────────────────────────────────────────────────────

  describe('complete()', () => {
    it('transitions to COMPLETED and attaches feedback', () => {
      const interview = makeSut();
      const fb = makeFeedback();
      interview.complete(fb);

      expect(interview.status).toBe(InterviewStatus.COMPLETED);
      expect(interview.feedback).toEqual(fb);
    });
  });

  // ── getConversationHistory() ─────────────────────────────────────────────────

  describe('getConversationHistory()', () => {
    it('maps interviewer → assistant, candidate → user', () => {
      const interview = makeSut();
      interview.addMessage('interviewer', 'Question?');
      interview.addMessage('candidate', 'Answer.');

      expect(interview.getConversationHistory()).toEqual([
        { role: 'assistant', content: 'Question?' },
        { role: 'user', content: 'Answer.' },
      ]);
    });

    it('returns empty array when no messages', () => {
      expect(makeSut().getConversationHistory()).toEqual([]);
    });
  });

  // ── fromJSON() ───────────────────────────────────────────────────────────────

  describe('fromJSON()', () => {
    it('round-trips a fully populated interview', () => {
      const original = makeSut();
      original.start();
      original.addMessage('interviewer', 'Tell me about yourself');
      original.addMessage('candidate', 'I am a developer');
      original.addVisionMetrics({ eye_contact: 0.8, stress_level: 0.2, confidence: 0.9 });
      original.setCurrentQuestion('Tell me about yourself');

      const json = JSON.parse(JSON.stringify(original)) as Record<string, unknown>;
      const restored = Interview.fromJSON(json);

      expect(restored.id).toBe(original.id);
      expect(restored.userId).toBe(original.userId);
      expect(restored.candidateId).toBe(original.candidateId);
      expect(restored.role).toBe(original.role);
      expect(restored.language).toBe(original.language);
      expect(restored.experienceLevel).toBe(original.experienceLevel);
      expect(restored.sessionVariant).toBe(original.sessionVariant);
      expect(restored.maxQuestions).toBe(original.maxQuestions);
      expect(restored.interviewer).toBe(original.interviewer);
      expect(restored.messages).toHaveLength(2);
      expect(restored.visionMetrics).toHaveLength(1);
      expect(restored.currentQuestion).toBe('Tell me about yourself');
    });

    it('throws when candidateId is missing', () => {
      expect(() => Interview.fromJSON({ role: 'dev' })).toThrow('Invalid interview data');
    });

    it('throws when role is missing', () => {
      expect(() => Interview.fromJSON({ candidateId: 'John' })).toThrow('Invalid interview data');
    });

    it('round-trips the interviewer persona', () => {
      const original = new Interview('Ana', 'dev', 'pt', 'mid', 'user-1', 5, 'female');
      const restored = Interview.fromJSON(JSON.parse(JSON.stringify(original)) as Record<string, unknown>);
      expect(restored.interviewer).toBe('female');
      expect(restored.maxQuestions).toBe(5);
    });

    it('falls back to the male persona for missing or unknown values', () => {
      expect(Interview.fromJSON({ candidateId: 'John', role: 'dev', interviewer: 'robot' }).interviewer).toBe('male');
    });

    it('defaults optional fields when absent', () => {
      const restored = Interview.fromJSON({ candidateId: 'John', role: 'dev' });
      expect(restored.interviewer).toBe('male');
      expect(restored.language).toBe('pt');
      expect(restored.experienceLevel).toBe('mid');
      expect(restored.maxQuestions).toBe(10);
      expect(restored.messages).toEqual([]);
      expect(restored.visionMetrics).toEqual([]);
    });
  });
});
