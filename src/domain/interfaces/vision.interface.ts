import { VisionMetrics } from '../entities/interview.entity';

export interface IVisionService {
  /** `sessionId` (the interview id) lets the vision service keep per-session smoothing state. */
  processFrame(frameBuffer: Buffer, sessionId?: string): Promise<VisionMetrics | null>;
  /** Best-effort cleanup of per-session state once the interview ends. */
  endSession(sessionId: string): Promise<void>;
}
