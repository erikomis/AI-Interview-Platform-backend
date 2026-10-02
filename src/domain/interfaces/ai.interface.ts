import { InterviewFeedback, VisionMetrics, Language, ExperienceLevel } from '../entities/interview.entity';

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
  /** Total questions in this session — drives the "Question i/N" hint and progression mapping. */
  maxQuestions?: number;
}

export interface EvaluateAnswerInput {
  question: string;
  answer: string;
  role: string;
  visionMetrics?: VisionMetrics | null;
  language?: Language;
}

export interface GenerateFeedbackInput {
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  visionMetrics: VisionMetrics | null;
  role: string;
  candidateName: string;
  experienceLevel: ExperienceLevel;
  sessionVariant: number;
  language?: Language;
}

export interface IAIService {
  generateQuestion(input: GenerateQuestionInput): Promise<string>;
  evaluateAnswer(input: EvaluateAnswerInput): Promise<string>;
  generateFeedback(input: GenerateFeedbackInput): Promise<InterviewFeedback>;
}
