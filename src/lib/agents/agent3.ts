/**
 * Agent 3 — Beszéd és időzítés (sima kód, nem LLM).
 * 4b-fix-2 verzió.
 *
 * Eltávolítva: estimateDurations() — szinte semmit nem csinált (a becslést mostantól
 * menet közben számoljuk, a mért mezőbe soha nem írunk becslést). Ha egy route még
 * hívja, töröld a hívást; a lockDurations() elvégzi a szükséges munkát.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  DEFAULT_SHOT_SECONDS,
  UNVERIFIED_VOICE_SETTINGS,
  computeShotDuration,
  estimateSpeechDuration,
  isUniqueViolation,
  pickCurrentUtterances,
  sortShots,
} from './agent3-helpers';

export {
  WORDS_PER_SECOND,
  UNVERIFIED_VOICE_SETTINGS,
  estimateSpeechDuration,
  calculateWavDuration,
  testWordCountEstimate,
} from './agent3-helpers';

export interface Agent3Result {
  success: boolean;
  message: string;
  data?: any;
}

const fail = (step: string, error?: any): Agent3Result => ({
  success: false,
  message: `Hiba történt: ${step}. (${error?.message ?? 'ismeretlen ok'})`,
});

// ---------------------------------------------------------------------------
// Jogosultság-ellenőrzések a route handlerekhez
// ---------------------------------------------------------------------------

/**
 * A FELHASZNÁLÓI (nem privilegizált) klienssel hívd. Igaz, ha a bejelentkezett
 * felhasználó a projekt tulajdonosa.
 */
export async function verifyProjectOwnership(userClient: SupabaseClient, projectId: string): Promise<boolean> {
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return false;
  const { data, error } = await userClient
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('user_id', userData.user.id)
    .maybeSingle();
  return !error && !!data;
}

/** Igaz, ha a beszéd valóban az adott projekthez tartozik. Privilegizált kliens előtt hívd. */
export async function verifyUtteranceInProject(
  client: SupabaseClient,
  utteranceId: string,
  projectId: string
): Promise<boolean> {
  const { data, error } = await client
    .from('utterances')
    .select('id')
    .eq('id', utteranceId)
    .eq('project_id', projectId)
    .maybeSingle();
  return !error && !!data;
}

// ---------------------------------------------------------------------------
// Közös betöltők
// ---------------------------------------------------------------------------

/** Egyetlen közös betöltő a rendezett felvételekhez (jelenetszám, majd felvételszám). */
async function loadOrderedShots(
  supabase: SupabaseClient,
  projectId: string
): Promise<{ ok: true; shots: any[] } | { ok: false; result: Agent3Result }> {
  const { data: scenes, error: scenesErr } = await supabase
    .from('scenes')
    .select('id, number')
    .eq('project_id', projectId);
  if (scenesErr) return { ok: false, result: fail('a jelenetek betöltése', scenesErr) };
  if (!scenes || scenes.length === 0) {
    return { ok: false, result: { success: false, message: 'Nincsenek jelenetek a projektben.' } };
  }

  const { data: shots, error: shotsErr } = await supabase
    .from('shots')
    .select('id, scene_id, number, dialogue_hu, target_duration_sec, status, speaker_character_id')
    .in('scene_id', scenes.map((s: any) => s.id));
  if (shotsErr) return { ok: false, result: fail('a felvételek betöltése', shotsErr) };
  if (!shots || shots.length === 0) {
    return { ok: false, result: { success: false, message: 'Nincsenek felvételek (shots) a projektben.' } };
  }

  return { ok: true, shots: sortShots(scenes as any[], shots as any[]) };
}

async function loadCurrentUtterances(supabase: SupabaseClient, projectId: string) {
  const { data, error } = await supabase.from('utterances').select('*').eq('project_id', projectId);
  if (error) return { ok: false as const, error };
  return { ok: true as const, map: pickCurrentUtterances((data ?? []) as any[]) };
}

// ---------------------------------------------------------------------------
// buildUtterances
// ---------------------------------------------------------------------------

/**
 * Felépíti a beszédeket és az idővonal-elemeket.
 * - Rendezés: jelenetszám, majd felvételszám; sequence_order = globális felvétel-pozíció.
 * - Párbeszéd nélküli felvétel: csak videóelem, nincs beszéd.
 * - Újrafuttatás biztonságos: nem hoz létre duplikátumot (a legmagasabb verziót használja).
 * - Egyediségi hibát ("már létezik") nem tekint hibának.
 */
export async function buildUtterances(supabase: SupabaseClient, projectId: string): Promise<Agent3Result> {
  try {
    const ordered = await loadOrderedShots(supabase, projectId);
    if (!ordered.ok) return ordered.result;

    let current = await loadCurrentUtterances(supabase, projectId);
    if (!current.ok) return fail('a meglévő beszédek betöltése', current.error);

    let createdCount = 0;
    let timelineStart = 0;

    for (const shot of ordered.shots) {
      const target = Number(shot.target_duration_sec) || DEFAULT_SHOT_SECONDS;
      const dialogue = (shot.dialogue_hu ?? '').trim();

      // --- videóelem ---
      const { data: videoItem, error: vSelErr } = await supabase
        .from('timeline_items')
        .select('id')
        .eq('project_id', projectId)
        .eq('track', 'video')
        .eq('shot_id', shot.id)
        .maybeSingle();
      if (vSelErr) return fail('a videóelem keresése az idővonalon', vSelErr);

      if (videoItem) {
        const { error } = await supabase
          .from('timeline_items')
          .update({ sequence_order: shot.position })
          .eq('id', videoItem.id);
        if (error) return fail('a videóelem sorrendjének frissítése', error);
      } else {
        const { error } = await supabase.from('timeline_items').insert({
          project_id: projectId,
          track: 'video',
          shot_id: shot.id,
          start_seconds: timelineStart,
          source_in: 0,
          source_out: target,
          duration_seconds: target,
          sequence_order: shot.position,
        });
        if (error && !isUniqueViolation(error)) return fail('a videóelem létrehozása', error);
      }

      // --- beszéd + feliratelem (csak ha van párbeszéd) ---
      if (dialogue) {
        let utter = current.map.get(shot.id);

        if (!utter) {
          const { data: created, error } = await supabase
            .from('utterances')
            .insert({
              project_id: projectId,
              source_shot_id: shot.id,
              character_id: shot.speaker_character_id ?? null,
              text_hu: dialogue,
              delivery_style: '',
              voice_settings: UNVERIFIED_VOICE_SETTINGS,
              duration_estimated: true,
              measured_duration_seconds: null,
              version: 1,
            })
            .select('*')
            .single();

          if (error && !isUniqueViolation(error)) return fail('a beszéd létrehozása', error);
          if (error) {
            // Közben valaki más létrehozta: újratöltjük.
            current = await loadCurrentUtterances(supabase, projectId);
            if (!current.ok) return fail('a beszédek újratöltése', current.error);
          } else {
            createdCount++;
            current.map.set(shot.id, created as any);
          }
          utter = current.map.get(shot.id);
          if (!utter) return fail('a beszéd megtalálása létrehozás után');
        } else if (shot.speaker_character_id && !utter.character_id) {
          // A beszélő kapcsolatot utólag is pótoljuk, ha a felvételhez került.
          const { error } = await supabase
            .from('utterances')
            .update({ character_id: shot.speaker_character_id })
            .eq('id', utter.id);
          if (error) return fail('a beszélő kapcsolat frissítése', error);
          utter = { ...utter, character_id: shot.speaker_character_id };
        }

        const { data: subItem, error: sSelErr } = await supabase
          .from('timeline_items')
          .select('id, utterance_id')
          .eq('project_id', projectId)
          .eq('track', 'subtitle')
          .eq('shot_id', shot.id)
          .maybeSingle();
        if (sSelErr) return fail('a feliratelem keresése', sSelErr);

        if (subItem) {
          const patch: any = { sequence_order: shot.position };
          if (subItem.utterance_id !== utter.id) patch.utterance_id = utter.id; // régi verzióról átirányítás
          const { error } = await supabase.from('timeline_items').update(patch).eq('id', subItem.id);
          if (error) return fail('a feliratelem frissítése', error);
        } else {
          const { error } = await supabase.from('timeline_items').insert({
            project_id: projectId,
            track: 'subtitle',
            shot_id: shot.id,
            utterance_id: utter.id,
            start_seconds: timelineStart,
            source_in: 0,
            source_out: target,
            duration_seconds: target,
            sequence_order: shot.position,
          });
          if (error && !isUniqueViolation(error)) return fail('a feliratelem létrehozása', error);
        }
      }

      timelineStart += target;
    }

    return {
      success: true,
      message: `Rendben: ${createdCount} új beszéd jött létre, az idővonal ellenőrizve.`,
      data: { createdCount, shotCount: ordered.shots.length },
    };
  } catch (err: any) {
    return fail('a beszédek felépítése', err);
  }
}

// ---------------------------------------------------------------------------
// synthesizeUtterance
// ---------------------------------------------------------------------------

/**
 * Hanggenerálás. Jelenleg NINCS valódi TTS-hívás megvalósítva.
 * - TTS_ENABLED nem 'true': felirat-tartalék, semmi nem íródik, nincs job.
 * - TTS_ENABLED 'true', de a hívás nincs megvalósítva: success:false, nincs job.
 *
 * TODO (valódi TTS-hívás bevezetésekor, kötelező sorrend):
 *   1. Csak közvetlenül a szolgáltatói hívás előtt hozz létre generation_jobs sort (step 'tts').
 *   2. Ha az ár nem igazoltan ingyenes: előbb reserve_budget (src/lib/budget.ts); ismeretlen ár = nincs hívás.
 *   3. Siker (fájl letöltve, nem üres, lejátszható) után settle_budget; megerősített hibánál release_budget;
 *      bizonytalan időtúllépésnél a job 'uncertain', a foglalás marad.
 *   4. A hang hosszát a valódi audioadatból mérd (calculateWavDuration), és ezt írd a measured_duration_seconds mezőbe.
 */
export async function synthesizeUtterance(
  supabase: SupabaseClient,
  utteranceId: string,
  projectId: string
): Promise<Agent3Result> {
  const { data: utterance, error } = await supabase
    .from('utterances')
    .select('id, project_id, text_hu')
    .eq('id', utteranceId)
    .eq('project_id', projectId)
    .maybeSingle();

  if (error) return fail('a beszéd betöltése', error);
  if (!utterance) return { success: false, message: 'A beszéd nem található ebben a projektben.' };

  const fallback = {
    fallback: true,
    label: 'becsült időtartam',
    durationSec: estimateSpeechDuration(utterance.text_hu),
  };

  if (process.env.TTS_ENABLED !== 'true') {
    return {
      success: true,
      message: 'A hanggenerálás ki van kapcsolva. Felirat jelenik meg, az időtartam becsült.',
      data: fallback,
    };
  }

  return {
    success: false,
    message: 'A hanggenerálás még nincs ellenőrizve/megvalósítva.',
    data: fallback,
  };
}

// ---------------------------------------------------------------------------
// lockDurations
// ---------------------------------------------------------------------------

/**
 * Felvételenként: hossz = max(tervezett, beszéd). A legmagasabb verziójú beszédet használja.
 * Mért hang: duration_estimated = false. Becsült beszéd: true. Párbeszéd nélkül: false.
 * A projekt állapotához nem nyúl. Csak a 'planned' felvételeket állítja 'audio_ready'-re.
 */
export async function lockDurations(supabase: SupabaseClient, projectId: string): Promise<Agent3Result> {
  try {
    const ordered = await loadOrderedShots(supabase, projectId);
    if (!ordered.ok) return ordered.result;

    const current = await loadCurrentUtterances(supabase, projectId);
    if (!current.ok) return fail('a beszédek betöltése', current.error);

    let clock = 0;
    const lengthenedShots: string[] = [];

    for (const shot of ordered.shots) {
      const { duration, estimated, lengthened } = computeShotDuration({
        targetSeconds: shot.target_duration_sec,
        dialogue: shot.dialogue_hu,
        utterance: current.map.get(shot.id) as any,
      });
      if (lengthened) lengthenedShots.push(shot.id);

      const shotPatch: any = { actual_duration_sec: duration, duration_estimated: estimated };
      if (shot.status === 'planned') shotPatch.status = 'audio_ready';

      const { error: shotErr } = await supabase.from('shots').update(shotPatch).eq('id', shot.id);
      if (shotErr) return fail('a felvétel időtartamának mentése', shotErr);

      const { error: tlErr } = await supabase
        .from('timeline_items')
        .update({ start_seconds: clock, duration_seconds: duration, source_out: duration })
        .eq('project_id', projectId)
        .eq('shot_id', shot.id);
      if (tlErr) return fail('az idővonal frissítése', tlErr);

      clock += duration;
    }

    return {
      success: true,
      message: `Az időtartamok lezárva (${ordered.shots.length} felvétel).`,
      data: { lockedCount: ordered.shots.length, totalDuration: clock, lengthenedShots },
    };
  } catch (err: any) {
    return fail('az időtartamok lezárása', err);
  }
}

// ---------------------------------------------------------------------------
// updateDialogueVersion
// ---------------------------------------------------------------------------

/**
 * Párbeszéd szerkesztése új verzióként. Biztonságos sorrend:
 *   1. új beszédverzió létrehozása (az idővonal még a régire mutat, minden érvényes),
 *   2. feliratelem átirányítása az újra,
 *   3. a felvétel dialogue_hu mezőjének frissítése.
 * Ha a 2. vagy 3. lépés hibázik, a változást visszavonjuk (legjobb tudás szerint), és hibát jelzünk.
 * Üres szöveg nem fogadható el. Utána futtasd a lockDurations-t az időzítés frissítéséhez.
 */
export async function updateDialogueVersion(
  supabase: SupabaseClient,
  utteranceId: string,
  projectId: string,
  newDialogue: string
): Promise<Agent3Result> {
  const text = (newDialogue ?? '').trim();
  if (!text) {
    return { success: false, message: 'A párbeszéd nem lehet üres. Egy sor eltávolítása más módon történik.' };
  }

  const { data: old, error: fetchErr } = await supabase
    .from('utterances')
    .select('*')
    .eq('id', utteranceId)
    .eq('project_id', projectId)
    .maybeSingle();
  if (fetchErr) return fail('az eredeti beszéd betöltése', fetchErr);
  if (!old) return { success: false, message: 'Az eredeti beszéd nem található ebben a projektben.' };
  if (!old.source_shot_id) {
    return { success: false, message: 'Ehhez a beszédhez nem tartozik felvétel, ezért nem szerkeszthető itt.' };
  }

  // Csak az aktuális (legmagasabb) verzió szerkeszthető.
  const { data: siblings, error: sibErr } = await supabase
    .from('utterances')
    .select('id, version')
    .eq('project_id', projectId)
    .eq('source_shot_id', old.source_shot_id);
  if (sibErr) return fail('a verziók betöltése', sibErr);
  const maxVersion = Math.max(...(siblings ?? []).map((s: any) => Number(s.version ?? 1)), Number(old.version ?? 1));
  if (Number(old.version ?? 1) < maxVersion) {
    return { success: false, message: 'Ez a beszéd már elavult verzió. Töltsd újra az oldalt, és az aktuálisat szerkeszd.' };
  }

  const nextVersion = maxVersion + 1;

  // 1. új verzió
  const { data: created, error: insErr } = await supabase
    .from('utterances')
    .insert({
      project_id: projectId,
      source_shot_id: old.source_shot_id,
      character_id: old.character_id ?? null,
      text_hu: text,
      delivery_style: old.delivery_style ?? '',
      voice_settings: old.voice_settings ?? UNVERIFIED_VOICE_SETTINGS,
      duration_estimated: true,
      measured_duration_seconds: null,
      version: nextVersion,
    })
    .select('id')
    .single();
  if (insErr) {
    return isUniqueViolation(insErr)
      ? { success: false, message: 'Közben valaki más is szerkesztette ezt a sort. Töltsd újra az oldalt.' }
      : fail('az új beszédverzió létrehozása', insErr);
  }

  const rollbackNew = async () => {
    await supabase.from('utterances').delete().eq('id', created.id);
  };

  // 2. idővonal átirányítása
  const { error: tlErr } = await supabase
    .from('timeline_items')
    .update({ utterance_id: created.id })
    .eq('utterance_id', old.id)
    .eq('track', 'subtitle');
  if (tlErr) {
    await rollbackNew();
    return fail('az idővonal átirányítása (a változás visszavonva)', tlErr);
  }

  // 3. felvétel szövegének frissítése
  const { error: shotErr } = await supabase
    .from('shots')
    .update({ dialogue_hu: text })
    .eq('id', old.source_shot_id);
  if (shotErr) {
    await supabase.from('timeline_items').update({ utterance_id: old.id }).eq('utterance_id', created.id).eq('track', 'subtitle');
    await rollbackNew();
    return fail('a felvétel szövegének frissítése (a változás visszavonva)', shotErr);
  }

  return {
    success: true,
    message: `A párbeszéd frissítve (${nextVersion}. verzió). A régi verzió megmaradt. Futtasd az időtartamok lezárását.`,
    data: { newUtteranceId: created.id, version: nextVersion },
  };
}
