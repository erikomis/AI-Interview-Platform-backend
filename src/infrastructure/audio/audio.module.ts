import { Module } from '@nestjs/common';
import { STTService } from './stt.service';
import { TTSService } from './tts.service';

@Module({
  providers: [
    { provide: 'ISTTService', useClass: STTService },
    { provide: 'ITTSService', useClass: TTSService },
  ],
  exports: ['ISTTService', 'ITTSService'],
})
export class AudioModule {}
