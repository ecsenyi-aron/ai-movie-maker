import { processShotAudio, TTSResult } from '../tts';

/**
 * Agent 3 — Audio and Timing (code, no LLM)
 * Processes all shots in a project, generates TTS or subtitle fallback,
 * measures actual/estimated duration, and locks durations downstream.
 */
export async function runAgent3ForShot(dialogueHu?: string | null, targetDuration: number = 4.0): Promise<TTSResult> {
  return await processShotAudio(dialogueHu, targetDuration);
}
