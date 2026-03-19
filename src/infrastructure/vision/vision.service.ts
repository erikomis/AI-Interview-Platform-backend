import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IVisionService } from '../../domain/interfaces/vision.interface';
import { VisionMetrics } from '../../domain/entities/interview.entity';

@Injectable()
export class VisionService implements IVisionService {
  private readonly logger = new Logger(VisionService.name);
  private readonly visionUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.visionUrl = this.configService.get('VISION_API_URL', 'http://localhost:8001');
  }

  async processFrame(frameBuffer: Buffer): Promise<VisionMetrics | null> {
    try {
      const res = await fetch(`${this.visionUrl}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frame: frameBuffer.toString('base64') }),
        signal: AbortSignal.timeout(5_000),
      });

      if (!res.ok) throw new Error(`Vision error ${res.status}`);

      return (await res.json()) as VisionMetrics;
    } catch (err) {
      this.logger.warn(`Vision service unavailable: ${(err as Error).message}`);
      return null;
    }
  }
}
