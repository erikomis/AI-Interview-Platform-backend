import { v4 as uuidv4 } from 'uuid';
import { InterviewStatus } from '../value-objects/interview-status.vo';

export type Language = 'pt' | 'en';
export type ExperienceLevel = 'junior' | 'mid' | 'senior';

export interface VisionMetrics {
  eye_contact: number;
  stress_level: number;
  confidence: number;
  /** Set by the vision service; frames where no face was detected carry no signal. */
  face_visible?: boolean;
}

export interface InterviewMessage {
  role: 'interviewer' | 'candidate';
  content: string;
  timestamp: Date;
  audioUrl?: string;
}

export class Interview {
  readonly id: string;
  readonly userId: string;
  readonly candidateId: string;
  readonly role: string;
  readonly language: Language;
  readonly experienceLevel: ExperienceLevel;
  readonly sessionVariant: number;
  readonly maxQuestions: number;
  status: InterviewStatus;
  messages: InterviewMessage[];
  visionMetrics: VisionMetrics[];
  currentQuestion: string | null;
  feedback: InterviewFeedback | null;
  createdAt: Date;
  updatedAt: Date;

  constructor(
    candidateId: string,
    role: string,
    language: Language = 'pt',
    experienceLevel: ExperienceLevel = 'mid',
    userId?: string,
    maxQuestionsParam?: number,
  ) {
    this.id = uuidv4();
    this.userId = userId ?? uuidv4();
    this.candidateId = candidateId;
    this.role = role;
    this.language = language;
    this.experienceLevel = experienceLevel;
    this.sessionVariant = Math.floor(Math.random() * 3) + 1;
    this.maxQuestions = maxQuestionsParam ?? 10;
    this.status = InterviewStatus.PENDING;
    this.messages = [];
    this.visionMetrics = [];
    this.currentQuestion = null;
    this.feedback = null;
    this.createdAt = new Date();
    this.updatedAt = new Date();
  }

  start(): void {
    if (this.status !== InterviewStatus.PENDING) {
      throw new Error('Interview already started');
    }
    this.status = InterviewStatus.IN_PROGRESS;
    this.updatedAt = new Date();
  }

  addMessage(role: 'interviewer' | 'candidate', content: string, audioUrl?: string): void {
    this.messages.push({ role, content, timestamp: new Date(), audioUrl });
    this.updatedAt = new Date();
  }

  addVisionMetrics(metrics: VisionMetrics): void {
    this.visionMetrics.push(metrics);
    this.updatedAt = new Date();
  }

  setCurrentQuestion(question: string): void {
    this.currentQuestion = question;
    this.updatedAt = new Date();
  }

  complete(feedback: InterviewFeedback): void {
    this.status = InterviewStatus.COMPLETED;
    this.feedback = feedback;
    this.updatedAt = new Date();
  }

  static fromJSON(data: Record<string, unknown>): Interview {
    if (typeof data.candidateId !== 'string' || typeof data.role !== 'string') {
      throw new Error('Invalid interview data: missing candidateId or role');
    }
    const interview = new Interview(
      data.candidateId,
      data.role,
      (data.language as Language) ?? 'pt',
      (data.experienceLevel as ExperienceLevel) ?? 'mid',
      typeof data.userId === 'string' ? data.userId : undefined,
    );
    Object.assign(interview, {
      id: typeof data.id === 'string' ? data.id : interview.id,
      status: data.status ?? interview.status,
      messages: Array.isArray(data.messages) ? data.messages : [],
      visionMetrics: Array.isArray(data.visionMetrics) ? data.visionMetrics : [],
      currentQuestion: typeof data.currentQuestion === 'string' ? data.currentQuestion : null,
      feedback: data.feedback ?? null,
      createdAt: data.createdAt ? new Date(data.createdAt as string) : new Date(),
      updatedAt: data.updatedAt ? new Date(data.updatedAt as string) : new Date(),
      sessionVariant: typeof data.sessionVariant === 'number' ? data.sessionVariant : 1,
      maxQuestions: typeof data.maxQuestions === 'number' ? data.maxQuestions : 10,
    });
    return interview;
  }

  getConversationHistory(): Array<{ role: 'user' | 'assistant'; content: string }> {
    return this.messages.map((m) => ({
      role: m.role === 'candidate' ? 'user' : 'assistant',
      content: m.content,
    }));
  }

  getAverageVisionMetrics(): VisionMetrics | null {
    // Ignore frames without a visible face and any non-finite values so a single
    // bad sample can't turn the whole average into NaN.
    const frames = this.visionMetrics.filter((m) => m && m.face_visible !== false);
    const avg = (key: 'eye_contact' | 'stress_level' | 'confidence'): number | null => {
      const values = frames.map((m) => m[key]).filter((v): v is number => Number.isFinite(v));
      return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;
    };
    const eye_contact = avg('eye_contact');
    const stress_level = avg('stress_level');
    const confidence = avg('confidence');
    if (eye_contact === null || stress_level === null || confidence === null) return null;
    return { eye_contact, stress_level, confidence };
  }
}

export interface InterviewFeedback {
  technical: number;
  communication: number;
  confidence: number;
  clarity: number;
  overall: number;
  summary: string;
  strengths: string[];
  improvements: string[];
}
