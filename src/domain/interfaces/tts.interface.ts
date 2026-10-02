import { Interviewer } from '../entities/interview.entity';

/** When a word starts in the audio and how long it lasts (milliseconds). */
export interface WordTiming {
  w: string;
  s: number;
  d: number;
}

export interface SpeechAudio {
  audio: Buffer;
  /** Empty when the provider doesn't report word boundaries */
  words: WordTiming[];
}

export interface ITTSService {
  /** `interviewer` picks the persona's voice for the language (defaults to male). */
  synthesize(text: string, language?: string, interviewer?: Interviewer): Promise<Buffer | null>;
  /** Same as `synthesize`, plus word timings that drive the avatar's lip-sync. */
  synthesizeWithTimings?(text: string, language?: string, interviewer?: Interviewer): Promise<SpeechAudio | null>;
}
