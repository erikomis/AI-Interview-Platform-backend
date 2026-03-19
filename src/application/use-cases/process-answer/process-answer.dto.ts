import { VisionMetrics } from '../../../domain/entities/interview.entity';

export class ProcessAnswerDto {
  interviewId: string;
  answer: string;
  userId: string;
  visionMetrics?: VisionMetrics;
}
