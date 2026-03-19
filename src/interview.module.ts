import { Module } from '@nestjs/common';
import { AIModule } from './infrastructure/ai/ai.module';
import { AudioModule } from './infrastructure/audio/audio.module';
import { VisionModule } from './infrastructure/vision/vision.module';
import { DatabaseModule } from './infrastructure/database/database.module';
import { AuthModule } from './auth.module';
import { MailModule } from './infrastructure/mail/mail.module';
import { StartInterviewUseCase } from './application/use-cases/start-interview/start-interview.use-case';
import { ProcessAnswerUseCase } from './application/use-cases/process-answer/process-answer.use-case';
import { GenerateFeedbackUseCase } from './application/use-cases/generate-feedback/generate-feedback.use-case';
import { InterviewGateway } from './presentation/gateways/interview.gateway';
import { InterviewController } from './presentation/controllers/interview.controller';

@Module({
  imports: [AIModule, AudioModule, VisionModule, DatabaseModule, AuthModule, MailModule],
  controllers: [InterviewController],
  providers: [
    StartInterviewUseCase,
    ProcessAnswerUseCase,
    GenerateFeedbackUseCase,
    InterviewGateway,
  ],
})
export class InterviewModule {}
