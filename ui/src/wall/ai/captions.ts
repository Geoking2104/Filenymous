/** Pure helpers for live captions (unit-tested). */

export const SAMPLE_RATE = 16_000;
/** Seconds of audio per transcription chunk. */
export const CHUNK_S = 8;
/** Below this RMS a chunk is treated as silence and not transcribed. */
export const SILENCE_RMS = 0.008;

export function rms(a: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * a[i]!;
  return a.length ? Math.sqrt(s / a.length) : 0;
}

/** Whisper's typical outputs on silence/noise, and empty results. */
const NOISE = /^[\s.,…!?-]*$|^\s*[[(（][^\])）]*[\])）]\s*$|^\s*(thank you\.?|thanks for watching!?|sous-titres réalisés par.*|merci\.?|you)\s*$/i;

/** Cleans a Whisper chunk; null when it is noise or a hallucination. */
export function cleanCaption(text: string): string | null {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t || NOISE.test(t)) return null;
  return t.slice(0, 1000);
}
