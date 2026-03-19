import { VisionMetrics } from '../entities/interview.entity';

export interface IVisionService {
  processFrame(frameBuffer: Buffer): Promise<VisionMetrics | null>;
}
