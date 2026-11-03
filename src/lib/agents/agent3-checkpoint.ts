/**
 * Agent 3 — checkpoint (jóváhagyási ellenőrzőpont) adatai.
 *
 * Ez a modul:
 *  - CSAK olvasható adatot ad vissza a felületnek (beszédek, felvételek, idővonal),
 *  - egyetlen beszéd időtartamát számolja újra (nem az egész projektet),
 *  - NEM hívja a lockDurations-t, és NEM nyúl a projekt állapotához.
 *
 * A költség mindig "ismeretlen", mert nincs ellenőrzött, szerveroldali árforrás.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  computeShotDuration,
  estimateSpeechDuration,
  pickCurrentUtterances,
  sortShots,
} from './agent3-helpers';
import { updateDialogueVersion, type Agent3Result } from './agent3';

export interface CheckpointTtsInfo {
  status: 'nincs bekapcsolva' | 'nincs ellenőrizve' | 'bekapcsolva';
  enabled: boolean;
  reason: string;
  costStatus: string;
}

export interface CheckpointUtterance {
  id: string;
  shotId: string;
  sceneNumber: number;
  shotNumber: number;
  speaker: string | null;
  text: string;
  version: number;
  hasOlderVersions: boolean;
  hasAudio: boolean;
  audioUrl: string | null;
  measuredDurationSec: number | null;
  estimatedDurationSec: number | null;
  durationSec: number;
  durationIsMeasured: boolean;
}

export interface CheckpointShot {
  id: string;
  sceneNumber: number;
  shotNumber: number;
  targetDurationSec: number;
  lockedDurationSec: number | null;
  durationEstimated: boolean;
  hasDialogue: boolean;
  lengthened: boolean;
}

export interface CheckpointTimelineItem {
  id: string;
  track: 'video' | 'audio' | 'subtitle';
  shotId: string | null;
  utteranceId: string | null;
  startSeconds: number;
  durationSeconds: number;
  sequenceOrder: number;
  sceneNumber: number | null;
  shotNumber: number | null;
}

export interface CheckpointData {
  projectId: string;
  tts: CheckpointTtsInfo;
  durationsLocked: boolean;
  shots: CheckpointShot[];
  utterances: CheckpointUtterance[];
  timeline: CheckpointTimelineItem[];
  totalDurationSec: number;
}

interface SceneRow {
  id: string;
  number: number;
}

interface ShotRow {
  id: string;
  scene_id: string;
  number: number;
  dialogue_hu: string | null;
  target_duration_sec: number | null;
  actual_duration_sec: number | null;
  duration_estimated: boolean | null;
  status: string | null;
}

interface UtteranceRow {
  id: string;
  project_id: string;
  character_id: string | null;
  source_shot_id: string | null;
  text_hu: string | null;
  audio_path: string | null;
  measured_duration_seconds: number | null;
  duration_estimated: boolean | null;
  version: number | null;
}

interface CharacterRow {
  id: string;
  name: string;
}

interface MediaRow {
  id: string;
  shot_id: string | null;
  type: string;
  storage_path: string | null;
  public_url: string | null;
  duration_sec: number | null;
}

interface TimelineRow {
  id: string;
  track: string | null;
  shot_id: string | null;
  utterance_id: string | null;
  start_seconds: number | null;
  duration_seconds: number | null;
  sequence_order: number | null;
}

const MEDIA_BUCKET = 'media';
const SIGNED_URL_TTL_SECONDS = 3600;

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

/** A TTS állapotot a szerver olvassa ki. A kliens soha nem lát környezeti változót. */
export function getTtsInfo(): CheckpointTtsInfo {
  const enabled = process.env.TTS_ENABLED === 'true';

  if (!enabled) {
    return {
      status: 'nincs bekapcsolva',
      enabled: false,
      costStatus: 'ismeretlen',
      reason:
        'A hanggenerálás (TTS) nincs bekapcsolva a szerveren, ezért hangfájl nem készül. ' +
        'Most felirat és becsült időtartam látható.',
    };
  }

  return {
    status: 'nincs ellenőrizve',
    enabled: false,
    costStatus: 'ismeretlen',
    reason:
      'A hanggenerálás be van kapcsolva, de még nincs ellenőrizve, és az ár is ismeretlen. ' +
      'Ezért a "Beszéd generálása" gomb tiltva marad.',
  };
}

/** Csak akkor ad vissza lejátszható URL-t, ha tényleg van hangfájl. */
async function resolveAudioUrl(
  supabase: SupabaseClient,
  utterance: UtteranceRow,
  mediaAsset: MediaRow | null
): Promise<string | null> {
  const publicUrl = typeof mediaAsset?.public_url === 'string' ? mediaAsset.public_url : '';
  if (publicUrl.startsWith('http://') || publicUrl.startsWith('https://')) return publicUrl;

  const path =
    (typeof mediaAsset?.storage_path === 'string' && mediaAsset.storage_path) ||
    (typeof utterance.audio_path === 'string' && utterance.audio_path) ||
    '';
  if (!path) return null;

  try {
    const { data, error } = await supabase.storage
      .from(MEDIA_BUCKET)
      .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
    if (error || !data?.signedUrl) return null;
    return String(data.signedUrl);
  } catch {
    return null;
  }
}

/**
 * Összesíti a checkpointhoz szükséges adatokat.
 * Nem ír semmit az adatbázisba.
 */
export async function getCheckpointData(
  supabase: SupabaseClient,
  projectId: string
): Promise<CheckpointData> {
  const { data: sceneRows, error: sceneErr } = await supabase
    .from('scenes')
    .select('id, number')
    .eq('project_id', projectId);
  if (sceneErr) throw new Error('A jelenetek betöltése nem sikerült.');

  const scenes = (sceneRows ?? []) as SceneRow[];
  const sceneIds = scenes.map((s) => s.id);

  let shotRows: ShotRow[] = [];
  if (sceneIds.length > 0) {
    const { data, error } = await supabase
      .from('shots')
      .select(
        'id, scene_id, number, dialogue_hu, target_duration_sec, actual_duration_sec, duration_estimated, status'
      )
      .in('scene_id', sceneIds);
    if (error) throw new Error('A felvételek betöltése nem sikerült.');
    shotRows = (data ?? []) as ShotRow[];
  }

  const orderedShots = sortShots(scenes, shotRows);

  const { data: utteranceRows, error: utteranceErr } = await supabase
    .from('utterances')
    .select('*')
    .eq('project_id', projectId);
  if (utteranceErr) throw new Error('A beszédek betöltése nem sikerült.');

  const allUtterances = (utteranceRows ?? []) as UtteranceRow[];
  const currentMap = pickCurrentUtterances(allUtterances);

  const versionCount = new Map<string, number>();
  for (const u of allUtterances) {
    if (!u.source_shot_id) continue;
    versionCount.set(u.source_shot_id, (versionCount.get(u.source_shot_id) ?? 0) + 1);
  }

  const { data: characterRows } = await supabase
    .from('characters')
    .select('id, name')
    .eq('project_id', projectId);
  const characterNames = new Map<string, string>(
    ((characterRows ?? []) as CharacterRow[]).map((c) => [c.id, c.name])
  );

  const { data: mediaRows } = await supabase
    .from('media_assets')
    .select('id, shot_id, type, storage_path, public_url, duration_sec')
    .eq('project_id', projectId)
    .eq('type', 'audio');
  const audioAssets = (mediaRows ?? []) as MediaRow[];

  const { data: timelineRows, error: timelineErr } = await supabase
    .from('timeline_items')
    .select('*')
    .eq('project_id', projectId);
  if (timelineErr) throw new Error('Az idővonal betöltése nem sikerült.');

  const sceneNumberById = new Map<string, number>(scenes.map((s) => [s.id, num(s.number)]));
  const shotInfoById = new Map<string, { sceneNumber: number; shotNumber: number }>();
  for (const shot of orderedShots) {
    shotInfoById.set(shot.id, {
      sceneNumber: sceneNumberById.get(shot.scene_id) ?? 0,
      shotNumber: num(shot.number),
    });
  }

  // --- felvételek ---
  const shots: CheckpointShot[] = [];
  for (const shot of orderedShots) {
    const info = shotInfoById.get(shot.id)!;
    const utterance = currentMap.get(shot.id) ?? null;
    const dialogue = (shot.dialogue_hu ?? '').trim();
    const { lengthened } = computeShotDuration({
      targetSeconds: shot.target_duration_sec,
      dialogue,
      utterance,
    });

    shots.push({
      id: shot.id,
      sceneNumber: info.sceneNumber,
      shotNumber: info.shotNumber,
      targetDurationSec: num(shot.target_duration_sec),
      lockedDurationSec:
        shot.actual_duration_sec === null || shot.actual_duration_sec === undefined
          ? null
          : num(shot.actual_duration_sec),
      durationEstimated: !!shot.duration_estimated,
      hasDialogue: dialogue.length > 0,
      lengthened,
    });
  }

  // --- beszédek (csak az aktuális, legmagasabb verzió) ---
  const utterances: CheckpointUtterance[] = [];
  for (const shot of orderedShots) {
    const utterance = currentMap.get(shot.id);
    if (!utterance) continue;

    const info = shotInfoById.get(shot.id)!;
    const text = (utterance.text_hu ?? '').trim();
    const measured = num(utterance.measured_duration_seconds);
    const estimated = estimateSpeechDuration(text);

    const asset =
      audioAssets.find(
        (a) =>
          a.shot_id === shot.id &&
          (typeof utterance.audio_path !== 'string' ||
            !utterance.audio_path ||
            a.storage_path === utterance.audio_path)
      ) ??
      audioAssets.find((a) => a.shot_id === shot.id) ??
      null;

    const audioUrl = await resolveAudioUrl(supabase, utterance, asset);
    const hasAudio = !!audioUrl;
    const durationIsMeasured = hasAudio && measured > 0;

    utterances.push({
      id: utterance.id,
      shotId: shot.id,
      sceneNumber: info.sceneNumber,
      shotNumber: info.shotNumber,
      speaker: utterance.character_id
        ? characterNames.get(utterance.character_id) ?? null
        : null,
      text,
      version: num(utterance.version) || 1,
      hasOlderVersions: (versionCount.get(shot.id) ?? 0) > 1,
      hasAudio,
      audioUrl,
      measuredDurationSec: measured > 0 ? measured : null,
      estimatedDurationSec: estimated,
      durationSec: durationIsMeasured ? measured : estimated,
      durationIsMeasured,
    });
  }

  // --- idővonal ---
  const timeline: CheckpointTimelineItem[] = ((timelineRows ?? []) as TimelineRow[])
    .map((item) => {
      const info = item.shot_id ? shotInfoById.get(item.shot_id) : undefined;
      const track: CheckpointTimelineItem['track'] =
        item.track === 'audio' || item.track === 'subtitle' ? item.track : 'video';
      return {
        id: item.id,
        track,
        shotId: item.shot_id ?? null,
        utteranceId: item.utterance_id ?? null,
        startSeconds: num(item.start_seconds),
        durationSeconds: num(item.duration_seconds),
        sequenceOrder: num(item.sequence_order),
        sceneNumber: info?.sceneNumber ?? null,
        shotNumber: info?.shotNumber ?? null,
      };
    })
    .sort((a, b) => a.startSeconds - b.startSeconds || a.sequenceOrder - b.sequenceOrder);

  const totalDurationSec = timeline.reduce(
    (max, item) => Math.max(max, item.startSeconds + item.durationSeconds),
    0
  );

  const durationsLocked =
    shots.length > 0 && shots.every((s) => s.lockedDurationSec !== null);

  return {
    projectId,
    tts: getTtsInfo(),
    durationsLocked,
    shots,
    utterances,
    timeline,
    totalDurationSec,
  };
}

/**
 * EGYETLEN beszéd időtartamát számolja újra (és csak annak felvételét módosítja).
 * A többi felvétel és beszéd nem változik.
 */
export async function recomputeUtteranceDuration(
  supabase: SupabaseClient,
  utteranceId: string,
  projectId: string
): Promise<Agent3Result> {
  const { data: utteranceRow, error: fetchErr } = await supabase
    .from('utterances')
    .select('*')
    .eq('id', utteranceId)
    .eq('project_id', projectId)
    .maybeSingle();
  if (fetchErr) {
    return {
      success: false,
      message: `Hiba történt: a beszéd betöltése. (${errorMessage(fetchErr, 'ismeretlen ok')})`,
    };
  }
  if (!utteranceRow) {
    return { success: false, message: 'A beszéd nem található ebben a projektben.' };
  }
  const utterance = utteranceRow as UtteranceRow;
  if (!utterance.source_shot_id) {
    return { success: false, message: 'Ehhez a beszédhez nem tartozik felvétel.' };
  }

  const { data: siblingRows, error: sibErr } = await supabase
    .from('utterances')
    .select('id, version')
    .eq('project_id', projectId)
    .eq('source_shot_id', utterance.source_shot_id);
  if (sibErr) {
    return {
      success: false,
      message: `Hiba történt: a verziók betöltése. (${errorMessage(sibErr, 'ismeretlen ok')})`,
    };
  }

  const siblings = (siblingRows ?? []) as Array<{ id: string; version: number | null }>;
  const maxVersion = Math.max(
    ...siblings.map((s) => num(s.version) || 1),
    num(utterance.version) || 1
  );
  if ((num(utterance.version) || 1) < maxVersion) {
    return { success: false, message: 'Ez a beszéd már elavult verzió. Töltsd újra az oldalt.' };
  }

  const { data: shotRow, error: shotErr } = await supabase
    .from('shots')
    .select('id, dialogue_hu, target_duration_sec')
    .eq('id', utterance.source_shot_id)
    .maybeSingle();
  if (shotErr) {
    return {
      success: false,
      message: `Hiba történt: a felvétel betöltése. (${errorMessage(shotErr, 'ismeretlen ok')})`,
    };
  }
  if (!shotRow) return { success: false, message: 'A felvétel nem található.' };
  const shot = shotRow as {
    id: string;
    dialogue_hu: string | null;
    target_duration_sec: number | null;
  };

  const { duration, estimated } = computeShotDuration({
    targetSeconds: shot.target_duration_sec,
    dialogue: shot.dialogue_hu,
    utterance,
  });

  const { error: shotUpdateErr } = await supabase
    .from('shots')
    .update({ actual_duration_sec: duration, duration_estimated: estimated })
    .eq('id', shot.id);
  if (shotUpdateErr) {
    return {
      success: false,
      message: `Hiba történt: a felvétel időtartamának mentése. (${errorMessage(shotUpdateErr, 'ismeretlen ok')})`,
    };
  }

  const { error: timelineErr } = await supabase
    .from('timeline_items')
    .update({ duration_seconds: duration, source_out: duration })
    .eq('project_id', projectId)
    .eq('shot_id', shot.id);
  if (timelineErr) {
    return {
      success: false,
      message: `Hiba történt: az idővonal frissítése. (${errorMessage(timelineErr, 'ismeretlen ok')})`,
    };
  }

  return {
    success: true,
    message: 'A felvétel időtartama újraszámolva.',
    data: { duration, estimated },
  };
}

/**
 * Párbeszéd szerkesztése új verzióként, majd CSAK az adott beszéd időtartamának újraszámolása.
 */
export async function updateDialogueAndRecompute(
  supabase: SupabaseClient,
  utteranceId: string,
  projectId: string,
  newDialogue: string
): Promise<Agent3Result> {
  const updated = await updateDialogueVersion(supabase, utteranceId, projectId, newDialogue);
  if (!updated.success) return updated;

  const newUtteranceId = updated.data?.newUtteranceId;
  if (!newUtteranceId) {
    return { success: false, message: 'A szerkesztés nem adott vissza új beszédverziót.' };
  }

  const recomputed = await recomputeUtteranceDuration(supabase, newUtteranceId, projectId);
  if (!recomputed.success) {
    return {
      success: false,
      message: `A szöveg mentve (${updated.data?.version}. verzió), de az időtartam újraszámolása nem sikerült: ${recomputed.message}`,
      data: updated.data,
    };
  }

  return {
    success: true,
    message: `A párbeszéd frissítve (${updated.data?.version}. verzió), az időtartam újraszámolva. A korábbi verzió megmaradt.`,
    data: { ...updated.data, ...recomputed.data },
  };
}
