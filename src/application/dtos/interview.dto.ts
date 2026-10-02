import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  IsBoolean,
  Min,
  Max,
  ValidateNested,
  IsIn,
  MaxLength,
  MinLength,
  IsUUID,
} from 'class-validator';
import { Type } from 'class-transformer';

const LANGUAGES = ['pt', 'en'] as const;
const EXPERIENCE_LEVELS = ['junior', 'mid', 'senior'] as const;
const SESSION_MODES = ['practice', 'full', 'intensive'] as const;
const INTERVIEWERS = ['male', 'female'] as const;

export const MAX_ANSWER_LENGTH = 10_000;
export const MAX_CV_LENGTH = 4000;

export class CreateInterviewDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  candidateId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  role: string;

  @IsOptional()
  @IsIn(LANGUAGES)
  language?: 'pt' | 'en';

  @IsOptional()
  @IsIn(EXPERIENCE_LEVELS)
  experienceLevel?: 'junior' | 'mid' | 'senior';

  @IsOptional()
  @IsIn(SESSION_MODES)
  sessionMode?: 'practice' | 'full' | 'intensive';

  /** Interviewer persona — male ("Alex") or female ("Sofia"); defaults to male. */
  @IsOptional()
  @IsIn(INTERVIEWERS)
  interviewer?: 'male' | 'female';

  @IsOptional()
  @IsString()
  @MaxLength(MAX_CV_LENGTH)
  cvSummary?: string;
}

export class VisionMetricsDto {
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1)
  eye_contact: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1)
  stress_level: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1)
  confidence: number;

  @IsOptional()
  @IsBoolean()
  face_visible?: boolean;
}

/** REST body for POST /interviews/:id/answer — the interview id comes from the URL. */
export class ProcessAnswerBodyDto {
  /** Accepted for backwards compatibility but ignored — the :id route param wins. */
  @IsOptional()
  @IsString()
  interviewId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(MAX_ANSWER_LENGTH)
  answer: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => VisionMetricsDto)
  visionMetrics?: VisionMetricsDto;
}

export class UpdateCvDto {
  @IsString()
  @MaxLength(MAX_CV_LENGTH)
  cvSummary: string;
}

// ─── WebSocket payloads ──────────────────────────────────────────────────────
// The global ValidationPipe does not apply to gateways — these are validated by
// the gateway-level WsValidationPipe.

export class WsStartInterviewDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  candidateId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  role: string;

  @IsOptional()
  @IsIn(LANGUAGES)
  language?: 'pt' | 'en';

  @IsOptional()
  @IsIn(EXPERIENCE_LEVELS)
  experienceLevel?: 'junior' | 'mid' | 'senior';

  @IsOptional()
  @IsIn(SESSION_MODES)
  sessionMode?: 'practice' | 'full' | 'intensive';

  /** Interviewer persona — male ("Alex") or female ("Sofia"); defaults to male. */
  @IsOptional()
  @IsIn(INTERVIEWERS)
  interviewer?: 'male' | 'female';

  @IsOptional()
  @IsString()
  @MaxLength(MAX_CV_LENGTH)
  cvSummary?: string;
}

export class WsUserAnswerDto {
  @IsUUID()
  interviewId: string;

  @IsString()
  @MinLength(1)
  @MaxLength(MAX_ANSWER_LENGTH)
  answer: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => VisionMetricsDto)
  visionMetrics?: VisionMetricsDto;
}

/** Audio to transcribe for review — the candidate edits the text before answering. */
export class WsTranscribeAudioDto {
  @IsUUID()
  interviewId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(14 * 1024 * 1024)
  audioBase64: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  mimeType?: string;
}

export class WsAudioAnswerDto {
  @IsUUID()
  interviewId: string;

  // Bounded by the socket's maxHttpBufferSize (15MB) — base64 of a ~10MB clip
  @IsString()
  @IsNotEmpty()
  @MaxLength(14 * 1024 * 1024)
  audioBase64: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  mimeType?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => VisionMetricsDto)
  visionMetrics?: VisionMetricsDto;
}

export class WsVisionMetricsDto {
  @IsUUID()
  interviewId: string;

  @IsOptional()
  @IsString()
  @MaxLength(3 * 1024 * 1024)
  frameBase64?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => VisionMetricsDto)
  metrics?: VisionMetricsDto;
}
