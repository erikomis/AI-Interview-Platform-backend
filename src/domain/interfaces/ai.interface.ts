import { InterviewFeedback, VisionMetrics, Language, ExperienceLevel, Interviewer } from '../entities/interview.entity';

/**
 * Thrown when the language model cannot be reached or returns no usable reply
 * (network error, timeout, non-2xx, error payload, empty content).
 */
export class AIUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AIUnavailableError';
  }
}

export interface GenerateQuestionInput {
  role: string;
  candidateName: string;
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  visionMetrics?: VisionMetrics | null;
  language?: Language;
  experienceLevel?: ExperienceLevel;
  sessionVariant?: number;
  cvContext?: string;
  previousTopics?: string[];
  /** Total questions in this session — drives the "question i of N" hint and progression mapping. */
  maxQuestions?: number;
  /** Interviewer persona (name/gender in the prompt); defaults to male. */
  interviewer?: Interviewer;
}

export interface EvaluateAnswerInput {
  question: string;
  answer: string;
  role: string;
  visionMetrics?: VisionMetrics | null;
  language?: Language;
  interviewer?: Interviewer;
}

export interface GenerateFeedbackInput {
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  visionMetrics: VisionMetrics | null;
  role: string;
  candidateName: string;
  experienceLevel: ExperienceLevel;
  sessionVariant: number;
  language?: Language;
  interviewer?: Interviewer;
}

export interface IAIService {
  generateQuestion(input: GenerateQuestionInput): Promise<string>;
  evaluateAnswer(input: EvaluateAnswerInput): Promise<string>;
  generateFeedback(input: GenerateFeedbackInput): Promise<InterviewFeedback>;
}
