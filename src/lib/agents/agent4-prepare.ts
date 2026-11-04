/**
 * Agent 4 előkészítő lépések (Mode A — Stock).
 *
 * Az `advance()` csak `audio_ready` állapotú felvételeket dolgoz fel.
 * Ezt az állapotot az Agent 3 `lockDurations()` függvénye állítja be
 * (`planned` -> `audio_ready`), ezért a stock gyűjtés előtt ezt le kell futtatni.
 *
 * A hívási sorrend kötött:
 *   1. `build_utterances` — létrehozza a beszédeket és az idővonal elemeit,
 *   2. `lock_durations`    — lezárja az időtartamokat és `audio_ready`-ra állítja a felvételeket.
 *
 * Ha az első lépés hibázik, a második nem fut le.
 * A `lockDurations` nem módosítja a projekt állapotát.
 *
 * Ez a modul tiszta: nincs hálózat és nincs adatbázis, csak a hívás sorrendje.
 */

/** Az Agent 3 által támogatott előkészítő akciók. */
export type PrepareAction = 'build_utterances' | 'lock_durations';

/** Egy előkészítő lépés eredménye. */
export interface PrepareStepResult {
  ok: boolean;
  message: string;
}

export interface PrepareResult {
  success: boolean;
  message: string;
  /** A ténylegesen meghívott akciók sorrendben (a hibásnál megállunk). */
  calls: PrepareAction[];
}

/**
 * Lefuttatja az Agent 3 előkészítő lépéseit a megadott sorrendben.
 *
 * @param callAction az adott akciót végrehajtó függvény (a hívó felelőssége a HTTP-hívás)
 */
export async function prepareShotsForStock(
  callAction: (action: PrepareAction) => Promise<PrepareStepResult>
): Promise<PrepareResult> {
  const calls: PrepareAction[] = [];

  // 1. beszédek + idővonal
  calls.push('build_utterances');
  const build = await callAction('build_utterances');
  if (!build.ok) {
    return {
      success: false,
      message: `A beszédek előkészítése nem sikerült: ${build.message}`,
      calls,
    };
  }

  // 2. időtartamok lezárása -> audio_ready
  calls.push('lock_durations');
  const lock = await callAction('lock_durations');
  if (!lock.ok) {
    return {
      success: false,
      message: `Az időtartamok lezárása nem sikerült: ${lock.message}`,
      calls,
    };
  }

  return {
    success: true,
    message: 'A felvételek előkészítve: a beszédek és az időtartamok lezárva.',
    calls,
  };
}
