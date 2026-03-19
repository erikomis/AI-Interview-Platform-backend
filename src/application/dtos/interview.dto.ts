import { IsString, IsNotEmpty, IsOptional, IsNumber, Min, Max, ValidateNested, IsIn, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateInterviewDto {
  @IsString()
  @IsNotEmpty()
  candidateId: string;

  @IsString()
  @IsNotEmpty()
  role: string;

  @IsOptional()
  @IsIn(['practice', 'full', 'intensive'])
  sessionMode?: 'practice' | 'full' | 'intensive';

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  cvSummary?: string;
}

export class VisionMetricsDto {
  @IsNumber()
  @Min(0)
  @Max(1)
  eye_contact: number;

  @IsNumber()
  @Min(0)
  @Max(1)
  stress_level: number;

  @IsNumber()
  @Min(0)
  @Max(1)
  confidence: number;
}

export class ProcessAnswerDto {
  @IsString()
  @IsNotEmpty()
  interviewId: string;

  @IsString()
  @IsNotEmpty()
  answer: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => VisionMetricsDto)
  visionMetrics?: VisionMetricsDto;
}
