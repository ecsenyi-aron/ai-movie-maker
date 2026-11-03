/**
 * Agent 3 — tiszta (adatbázis nélküli) segédfüggvények.
 * Ezek könnyen tesztelhetők, és nem hívnak külső szolgáltatást.
 */

// FIGYELEM: nincs mérve. Magyar beszéd átlagos tempója szó/másodpercben.
// Konzervatív érték, hogy a becslés ne legyen túl rövid. Állítható.
export const WORDS_PER_SECOND = 2.2;

// Ha a felvételnek nincs megadott hossza.
export const DEFAULT_SHOT_SECONDS = 4.0;

export const UNVERIFIED_VOICE_SETTINGS = {
  voice: null,
  provider: 'gemini_tts_unverified',
  tts_status: 'nincs ellenőrizve',
};

export function estimateSpeechDuration(text?: string | null): number {
  if (!text || !text.trim()) return 0;
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(2.0, Number((words / WORDS_PER_SECOND).toFixed(3)));
}

export function testWordCountEstimate(text: string): number {
  return estimateSpeechDuration(text);
}

/** Nyers PCM (alapból 24 kHz, 16 bit, mono) hossza másodpercben a bájtok számából. */
export function calculateWavDuration(
  byteLength: number,
  sampleRate = 24000,
  channels = 1,
  bitsPerSample = 16
): number {
  const bytesPerSample = bitsPerSample / 8;
  return Number((byteLength / (channels * bytesPerSample) / sampleRate).toFixed(3));
}

export function isUniqueViolation(err: any): boolean {
  return !!err && (err.code === '23505' || /duplicate key|unique/i.test(err.message ?? ''));
}

export interface SceneLike {
  id: string;
  number: number;
}
export interface ShotLike {
  id: string;
  scene_id: string;
  number: number;
}

/**
 * Felvételek sorrendje: JELENET SZÁMA, majd felvétel száma.
 * (A scene_id véletlen azonosító, ezért soha nem rendezünk vele.)
 * A position a globális, 1-től induló futó sorszám.
 */
export function sortShots<T extends ShotLike>(
  scenes: SceneLike[],
  shots: T[]
): Array<T & { position: number }> {
  const sceneNumber = new Map<string, number>();
  for (const s of scenes) sceneNumber.set(s.id, Number(s.number));
  return shots
    .filter((sh) => sceneNumber.has(sh.scene_id))
    .sort((a, b) => {
      const sa = sceneNumber.get(a.scene_id)!;
      const sb = sceneNumber.get(b.scene_id)!;
      if (sa !== sb) return sa - sb;
      return Number(a.number) - Number(b.number);
    })
    .map((sh, i) => ({ ...sh, position: i + 1 }));
}

/** Felvételenként a legmagasabb verziójú (aktuális) beszéd. */
export function pickCurrentUtterances<U extends { source_shot_id?: string | null; version?: number | null }>(
  list: U[]
): Map<string, U> {
  const map = new Map<string, U>();
  for (const u of list) {
    if (!u.source_shot_id) continue;
    const prev = map.get(u.source_shot_id);
    if (!prev || Number(u.version ?? 1) > Number(prev.version ?? 1)) map.set(u.source_shot_id, u);
  }
  return map;
}

export interface DurationInput {
  targetSeconds: number | string | null | undefined;
  dialogue: string | null | undefined; // a felvétel jelenlegi párbeszéde
  utterance?: {
    text_hu?: string | null;
    audio_path?: string | null;
    measured_duration_seconds?: number | string | null;
  } | null;
}

/**
 * Végleges felvételhossz = max(tervezett hossz, beszéd hossza).
 * estimated = true csak akkor, ha van párbeszéd, és nincs valódi, mért hangfájl.
 * Párbeszéd nélküli felvétel: a tervezett hossz a végleges, nem becsült.
 */
export function computeShotDuration(input: DurationInput): {
  duration: number;
  estimated: boolean;
  lengthened: boolean;
} {
  const target = Number(input.targetSeconds) || DEFAULT_SHOT_SECONDS;
  const dialogue = (input.dialogue ?? '').trim();
  if (!dialogue) return { duration: target, estimated: false, lengthened: false };

  const u = input.utterance;
  const measured = Number(u?.measured_duration_seconds);
  let speech: number;
  let estimated: boolean;
  if (u?.audio_path && measured > 0) {
    speech = measured;
    estimated = false;
  } else {
    speech = estimateSpeechDuration(u?.text_hu ?? dialogue);
    estimated = true;
  }
  return { duration: Math.max(target, speech), estimated, lengthened: speech > target };
}
