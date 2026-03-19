import { Module } from '@nestjs/common';
import { AIService } from './ai.service';

@Module({
  providers: [
    {
      provide: 'IAIService',
      useClass: AIService,
    },
  ],
  exports: ['IAIService'],
})
export class AIModule {}
