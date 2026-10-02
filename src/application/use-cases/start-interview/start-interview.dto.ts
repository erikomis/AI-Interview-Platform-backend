import { Language, ExperienceLevel, Interviewer } from '../../../domain/entities/interview.entity';

export class StartInterviewDto {
  candidateId: string;
  role: string;
  language?: Language;
  experienceLevel?: ExperienceLevel;
  interviewer?: Interviewer;
  userId: string;
  sessionMode?: 'practice' | 'full' | 'intensive';
  cvSummary?: string;
}
