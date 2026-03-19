import { Module } from '@nestjs/common';
import { VisionService } from './vision.service';

@Module({
  providers: [
    { provide: 'IVisionService', useClass: VisionService },
  ],
  exports: ['IVisionService'],
})
export class VisionModule {}
