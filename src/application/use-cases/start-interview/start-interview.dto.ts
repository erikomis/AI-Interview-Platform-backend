import { Language, ExperienceLevel } from '../../../domain/entities/interview.entity';

export class StartInterviewDto {
  candidateId: string;
  role: string;
  language?: Language;
  experienceLevel?: ExperienceLevel;
  userId: string;
  sessionMode?: 'practice' | 'full' | 'intensive';
  cvSummary?: string;
}
