/**
 * Agent 4 — Prémium munkafolyamat döntési rétege (tiszta függvények).
 *
 * Ez a modul NEM hálózatot, NEM adatbázist és NEM providert használ.
 * A Premium workflow (`agent4-premium.ts`) ezekre a szabályokra épül,
 * így a döntési logika teljesen unit tesztekkel lefedhető.
 *
 * A SPECifikációtól való ELTÉRÉS (jelentendő a végén):
 * a Spec.md "legfeljebb egy újrapróbálás per shot" szabálya helyett
 * itt EGY PRÓBÁLKOZÁS van lépésenként és felvételenként. Automatikus
 * újrapróbálás nincs; az újrapróbálás manuális, felhasználó által
 * indított, és ugyanazt a szerveroldali költségvetési ellenőrzést
 * futtatja, mint az első próbálkozás.
 */

import {
  FAL_ENDPOINTS,
  FAL_REFERENCE_IMAGE_MEGAPIXELS,
  estimateStepCostUsd,
} from './agent4-premium-config.ts';

/** A Prémium munkafolyamat fázisai. */
export type PremiumPhase = 'reference' | 'video' | 'done';

/** A következő lépés kiválasztásának eredménye. */
export interface PremiumPhaseDecision {
  phase: PremiumPhase;
  /** Magyar indoklás (a UI és a napló számára). */
  reason: string;
}

/**
 * A következő Premium lépés kiválasztása.
 *
 * A sorrend kötött:
 * 1. a referenciaképek készülnek el (projektenként, minden hiányzó
 *    karakterhez és helyszínhez EGYSZER),
 * 2. csak utána jönnek a felvételenkénti videók, film sorrendben.
 */
export function selectNextPhase(input: {
  /** Van-e még folyamatban lévő referencia feladat (poll). */
  hasPendingReferenceJobs: boolean;
  /** A hiányzó referenciák száma (karakter + helyszín). */
  missingReferenceCount: number;
  /** A még nem kész felvételek száma (film sorrendben). */
  pendingVideoShotCount: number;
}): PremiumPhaseDecision {
  if (input.hasPendingReferenceJobs) {
    return { phase: 'reference', reason: 'A referencia feladat folyamatban van, lekérdezés szükséges.' };
  }
  if (input.missingReferenceCount > 0) {
    return {
      phase: 'reference',
      reason: `Hiányzó referenciakép: ${input.missingReferenceCount} db. A videók csak a referenciák után készülnek.`,
    };
  }
  if (input.pendingVideoShotCount > 0) {
    return { phase: 'video', reason: 'A referenciák megvannak, a felvételek videója készül.' };
  }
  return { phase: 'done', reason: 'Nincs további teendő.' };
}

/** Az egy-próbálkozás szabály eredménye. */
export interface AttemptDecision {
  allowed: boolean;
  /** Magyar indoklás. */
  reason: string;
}

/**
 * Egy lépés indítható-e?
 *
 * - Nincs korábbi próbálkozás -> igen.
 * - Van korábbi próbálkozás, és a felhasználó kérte -> igen (manuális
 *   újrapróbálás; a költségvetési ellenőrzés ugyanúgy fut).
 * - Van korábbi próbálkozás, és nem a felhasználó kérte -> nem
 *   (nincs automatikus újrapróbálás).
 */
export function isStepAttemptAllowed(input: {
  /** A (tulajdonos vagy felvétel, lépés) kulcsra már létező feladatok száma. */
  existingAttempts: number;
  /** A felhasználó manuálisan kérte-e az újrapróbálást. */
  manualRetry: boolean;
}): AttemptDecision {
  if (input.existingAttempts <= 0) {
    return { allowed: true, reason: 'Ez az első próbálkozás.' };
  }
  if (input.manualRetry) {
    return {
      allowed: true,
      reason: 'Manuális újrapróbálás (a költségvetési ellenőrzés a szerveren fut).',
    };
  }
  return {
    allowed: false,
    reason:
      'Ehhez a lépéshez már volt egy próbálkozás. Automatikus újrapróbálás nincs; manuálisan kérhető újrapróbálás.',
  };
}

/** A videó időtartamának kiválasztása. */
export interface VideoDurationDecision {
  /** A kiválasztott támogatott időtartam másodpercben (null = nincs). */
  durationSec: number | null;
  /** Igaz, ha a felvétel `needs_review` állapotba kerül. */
  needsReview: boolean;
  /** Magyar indoklás. */
  reason: string;
}

/**
 * A felvételhez tartozó támogatott videóidőtartam.
 *
 * - A cél az `actual_duration_sec` (a hanghossz).
 * - A támogatott értékek közül a célhoz legközelebbi kerül kiválasztásra.
 * - Ha ez rövidebb lenne a hangnál, de van hosszabb támogatott érték,
 *   azt vesszük (a hang legyen teljes).
 * - Ha nincs ilyen, a felvétel `needs_review` lesz.
 */
export function computeVideoDuration(input: {
  desiredSec: number;
  audioSec: number | null;
  supported: number[] | null;
}): VideoDurationDecision {
  const supported = (input.supported ?? []).filter((d) => Number.isFinite(d) && d > 0);
  if (supported.length === 0) {
    return {
      durationSec: null,
      needsReview: true,
      reason: 'Nincs ellenőrzött támogatott videóidőtartam: a felvétel kézi ellenőrzést igényel.',
    };
  }

  const desired = Number(input.desiredSec);
  const audio = input.audioSec === null ? null : Number(input.audioSec);

  if (!Number.isFinite(desired) || desired <= 0) {
    return {
      durationSec: null,
      needsReview: true,
      reason: 'A felvétel időtartama nem határozható meg: a felvétel kézi ellenőrzést igényel.',
    };
  }

  const sorted = [...supported].sort((a, b) => a - b);

  // A hang legyen teljes: a videó nem lehet rövidebb sem a célnál
  // (actual_duration_sec), sem a hanghossznál.
  const lowerBound = Math.max(
    desired,
    audio !== null && Number.isFinite(audio) && audio > 0 ? audio : 0
  );
  const longEnough = sorted.find((d) => d >= lowerBound);

  if (longEnough !== undefined) {
    const isRoundedUp = longEnough > desired;
    return {
      durationSec: longEnough,
      needsReview: false,
      reason: isRoundedUp
        ? `A videóidőtartam ${longEnough} másodperc (a hang teljes, a cél ${desired} másodperc volt).`
        : `A videóidőtartam ${longEnough} másodperc (a legközelebbi támogatott érték).`,
    };
  }

  // Nincs elég hosszú támogatott érték: a felvétel kézi ellenőrzést igényel.
  if (audio !== null && Number.isFinite(audio) && audio > 0) {
    return {
      durationSec: null,
      needsReview: true,
      reason: `A hang ${audio} másodperc, de nincs ilyen hosszú támogatott videóidőtartam: a felvétel kézi ellenőrzést igényel.`,
    };
  }
  return {
    durationSec: null,
    needsReview: true,
    reason: `Nincs ${desired} másodperc vagy hosszabb támogatott videóidőtartam: a felvétel kézi ellenőrzést igényel.`,
  };
}

/** A referencia kép becsült költsége USD-ben (null = ismeretlen). */
export function estimateReferenceCostUsd(): number | null {
  return estimateStepCostUsd('reference_image', {
    megapixels: FAL_REFERENCE_IMAGE_MEGAPIXELS,
  });
}

/** A videó becsült költsége USD-ben (null = ismeretlen). */
export function estimateVideoCostUsd(durationSec: number): number | null {
  return estimateStepCostUsd('video', { durationSec });
}

/** A költség megjelenítése: az ismeretlen ár "ismeretlen". */
export function formatCostUsd(cost: number | null | undefined): string {
  if (cost === null || cost === undefined || !Number.isFinite(cost)) return 'ismeretlen';
  return `$${cost.toFixed(4)}`;
}

/** A lépés becsült költsége a UI-hoz (null = ismeretlen). */
export function estimatePhaseCostUsd(
  phase: PremiumPhase,
  options: { durationSec?: number } = {}
): number | null {
  if (phase === 'reference') return estimateReferenceCostUsd();
  if (phase === 'video') {
    const duration = Number(options.durationSec ?? 0);
    if (!Number.isFinite(duration) || duration <= 0) return null;
    return estimateVideoCostUsd(duration);
  }
  return null;
}

/** Igaz, ha az adott Premium lépés valódi providerrel futtatható (ár + endpoint). */
export function isPhaseConfigured(phase: PremiumPhase): boolean {
  if (phase === 'reference') {
    const cfg = FAL_ENDPOINTS.reference_image;
    return Boolean(cfg.endpointId && cfg.unitPriceUsd !== null);
  }
  if (phase === 'video') {
    const cfg = FAL_ENDPOINTS.video;
    return Boolean(cfg.endpointId && cfg.unitPriceUsd !== null);
  }
  return true;
}

/** A Stock helyettesítő felajánlása: egy sikertelen lépés után. */
export function shouldOfferStockFallback(input: {
  /** A lépés sikertelen volt-e. */
  jobFailed: boolean;
  /** A felvétel már `clip_ready`? (Ilyenkor nem kell helyettesítő.) */
  shotAlreadyReady: boolean;
}): boolean {
  return input.jobFailed && !input.shotAlreadyReady;
}

/** A felvétel `qc_notes` mezőjéhez adandó magyar megjegyzés. */
export function buildFailureNote(step: 'reference_image' | 'video' | 'lipsync', error: string): string {
  const label =
    step === 'reference_image'
      ? 'A referencia kép készítése'
      : step === 'video'
        ? 'A felvétel videójának készítése'
        : 'A lip-sync készítése';
  return `${label} nem sikerült: ${error} (Stock helyettesítő választható).`;
}
