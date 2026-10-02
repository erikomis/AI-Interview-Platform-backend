import { Interviewer } from '../../domain/entities/interview.entity';
import { ITTSService, WordTiming } from '../../domain/interfaces/tts.interface';

export interface SpokenText {
  audioBase64: string | null;
  words: WordTiming[];
}

/**
 * Voices `text` with the persona's neural voice. TTS is best-effort: on any
 * failure the client still shows the text, so this never throws.
 */
export async function speakBestEffort(
  tts: ITTSService,
  text: string,
  language: string,
  interviewer: Interviewer,
): Promise<SpokenText> {
  try {
    if (tts.synthesizeWithTimings) {
      const speech = await tts.synthesizeWithTimings(text, language, interviewer);
      return speech ? { audioBase64: speech.audio.toString('base64'), words: speech.words } : { audioBase64: null, words: [] };
    }
    const audio = await tts.synthesize(text, language, interviewer);
    return { audioBase64: audio ? audio.toString('base64') : null, words: [] };
  } catch {
    return { audioBase64: null, words: [] };
  }
}
