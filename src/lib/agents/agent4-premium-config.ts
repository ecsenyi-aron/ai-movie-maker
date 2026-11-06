/**
 * Agent 4 — Prémium (fal.ai) szerveroldali konfiguráció.
 *
 * FONTOS: ebben a fájlban CSAK hivatalos fal.ai dokumentációból ellenőrzött
 * értékek szerepelnek. Minden bejegyzés tartalmazza a forrás-URL-t és az
 * ellenőrzés dátumát. A nem ellenőrzött érték `null`, és az adott lépés
 * letiltva marad (a valódi provider nem hívható).
 *
 * Ellenőrzés dátuma: 2026-11-04 (kiegészítve: 2026-11-05)
 * Források:
 * - Queue API (OpenAPI): https://fal.ai/api/openapi/queue/openapi.json?openapi=3.0.1
 * - Hitelesítés: https://fal.ai/docs/model-apis/authentication
 * - flux/schnell: https://fal.ai/models/fal-ai/flux/schnell/api
 * - flux/dev: https://fal.ai/models/fal-ai/flux/dev/api
 * - kling v3 standard image-to-video: https://fal.ai/models/fal-ai/kling-video/v3/standard/image-to-video/api
 * - kling lipsync audio-to-video: https://fal.ai/models/fal-ai/kling-video/lipsync/audio-to-video/api
 */

/** Az ellenőrzés dátuma, amikor a lent rögzített értékeket ellenőriztük. */
export const FAL_CONFIG_VERIFIED_AT = '2026-11-04';

/** A legutóbbi kiegészítő ellenőrzés dátuma (a multi-reference és a gyorsítótár miatt). */
export const FAL_CONFIG_LAST_RECHECKED_AT = '2026-11-05';

/** A fal.ai Queue API alap címe (OpenAPI: servers[0].url). */
export const FAL_QUEUE_BASE_URL = 'https://queue.fal.run';

/** A fal.ai Queue API útvonal-mintái (OpenAPI: paths). */
export const FAL_QUEUE_PATHS = {
  submit: '/{endpoint_id}',
  status: '/{endpoint_id}/requests/{request_id}/status',
  result: '/{endpoint_id}/requests/{request_id}',
} as const;

/** A Queue API státuszai (OpenAPI: QueueStatus.status enum). */
export type FalQueueStatus = 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED';

/** A Premium mód lépései. */
export type PremiumStep = 'reference_image' | 'video' | 'lipsync';

/** Egy ellenőrzött fal.ai endpoint leírása. */
export interface FalEndpointConfig {
  /** A fal.ai endpoint azonosítója (a queue hívás path-paramétere). */
  endpointId: string;
  /** A hivatalos dokumentáció oldala, ahol az értékek ellenőrizve lettek. */
  sourceUrl: string;
  /** Az ellenőrzés dátuma (YYYY-MM-DD). */
  verifiedAt: string;
  /** Az árazási egység ('seconds' | 'units' | 'megapixels'). */
  billingUnit: string | null;
  /** Az egységár USD-ben. `null` = nem ellenőrzött / ismeretlen. */
  unitPriceUsd: number | null;
  /** A támogatott időtartamok másodpercben (video lépésnél). */
  supportedDurationsSec: number[] | null;
  /** A bemeneti mezők nevei (a hivatalos séma alapján). */
  inputFields: string[] | null;
  /** A kimeneti mezők nevei (a hivatalos séma alapján). */
  outputFields: string[] | null;
  /**
   * Támogatja-e a modell több referencia képet egy hívásban.
   * `null` = nem ellenőrzött / ismeretlen (a lépés ilyenkor tiltva marad).
   */
  supportsMultipleReferences: boolean | null;
  /** A modell által elfogadott referencia-kép formátum rövid leírása. */
  multipleReferenceNote: string | null;
  /** A bemeneti videóra vonatkozó korlátok (lip-sync lépés). */
  inputVideoConstraints: { minDurationSec: number; maxDurationSec: number; maxBytes: number; note: string } | null;
}

/**
 * A fal.ai endpointok — kizárólag ellenőrzött értékekkel.
 * A `null` érték azt jelenti: "nincs ellenőrzött adat", ilyen lépés nem futhat.
 */
export const FAL_ENDPOINTS: Record<PremiumStep, FalEndpointConfig> = {
  reference_image: {
    // A referenciaképekhez a FLUX Schnell endpointot használjuk (olcsóabb, gyorsabb).
    endpointId: 'fal-ai/flux/schnell',
    sourceUrl: 'https://fal.ai/models/fal-ai/flux/schnell/api',
    verifiedAt: FAL_CONFIG_VERIFIED_AT,
    billingUnit: 'megapixels',
    unitPriceUsd: 0.003,
    supportedDurationsSec: null,
    inputFields: ['prompt', 'image_size', 'width', 'height', 'num_inference_steps', 'seed', 'guidance_scale', 'sync_mode', 'num_images', 'enable_safety_checker', 'output_format', 'acceleration'],
    outputFields: ['images', 'timings', 'seed', 'has_nsfw_concepts', 'prompt'],
    supportsMultipleReferences: false,
    multipleReferenceNote: null,
    inputVideoConstraints: null,
  },
  video: {
    endpointId: 'fal-ai/kling-video/v3/standard/image-to-video',
    sourceUrl: 'https://fal.ai/models/fal-ai/kling-video/v3/standard/image-to-video/api',
    verifiedAt: FAL_CONFIG_LAST_RECHECKED_AT,
    billingUnit: 'seconds',
    // Hivatalos oldal (2026-11-05): "$0.084 per second (audio off)".
    // Hang nélküli alaphangzást használunk, ezért ez az alkalmazott egységár.
    unitPriceUsd: 0.084,
    // A hivatalos DurationEnum értékei: 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15
    supportedDurationsSec: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    inputFields: ['prompt', 'start_image_url', 'end_image_url', 'duration', 'generate_audio', 'negative_prompt', 'cfg_scale', 'enable_safety_checker', 'multi_prompt', 'elements', 'shot_type'],
    outputFields: ['video', 'timings', 'seed', 'prompt', 'duration'],
    // IGEN: a modell több referencia képet is elfogad, de nem lapos URL-listaként:
    // az `elements` tömb minden eleme egy "képkészlet" (frontal_image_url + 1–3
    // reference_image_urls), amire a promptban @Element1, @Element2 formában lehet
    // hivatkozni. Hivatalos séma: KlingV3ComboElementInput.
    supportsMultipleReferences: true,
    multipleReferenceNote:
      'Több referencia kép támogatott az `elements` tömbön keresztül: minden elemhez frontal_image_url és 1–3 reference_image_urls adható (a hivatalos séma szerint legalább 300 px, legfeljebb 50 MB, 0.4–2.5 képarány); a promptban @Element1, @Element2 formában hivatkozhatók.',
    inputVideoConstraints: null,
  },
  lipsync: {
    endpointId: 'fal-ai/kling-video/lipsync/audio-to-video',
    sourceUrl: 'https://fal.ai/models/fal-ai/kling-video/lipsync/audio-to-video/api',
    verifiedAt: FAL_CONFIG_VERIFIED_AT,
    billingUnit: 'units',
    unitPriceUsd: 0.014,
    supportedDurationsSec: null,
    inputFields: ['video_url', 'audio_url', 'enable_safety_checker'],
    outputFields: ['video'],
    supportsMultipleReferences: false,
    multipleReferenceNote: null,
    // A hivatalos séma szerint a bemeneti videó 2–10 másodperc, 720p/1080p,
    // legfeljebb 100 MB, .mp4 vagy .mov formátum.
    inputVideoConstraints: {
      minDurationSec: 2,
      maxDurationSec: 10,
      maxBytes: 100 * 1024 * 1024,
      note: 'A lip-sync bemeneti videója 2–10 másodperc, 720p vagy 1080p, legfeljebb 100 MB (.mp4/.mov).',
    },
  },
};

/** A flux/schnell alapértelmezett kép mérete (hivatalos séma: image_size enum). */
export const FAL_REFERENCE_IMAGE_SIZE = 'landscape_4_3';

/** A flux/schnell egyedi szélesség (hivatalos példa: width 1280, height 720). */
export const FAL_REFERENCE_IMAGE_WIDTH = 1280;
export const FAL_REFERENCE_IMAGE_HEIGHT = 720;

/**
 * A flux/schnell megapixel-alapú árazásához a kép mérete.
 * 1280x720 = 0,9216 MP -> 0,9216 * 0,003 USD = 0,0027648 USD.
 */
export const FAL_REFERENCE_IMAGE_MEGAPIXELS =
  (FAL_REFERENCE_IMAGE_WIDTH * FAL_REFERENCE_IMAGE_HEIGHT) / 1_000_000;

/** A lip-sync egységszám: egy felvételhez egy egység (a hivatalos oldal "units" egységet ad meg). */
export const FAL_LIPSYNC_UNITS = 1;

/** A Premium provider neve a generation_jobs.provider mezőben. */
export const FAL_PROVIDER = 'fal';

/** A Mock provider neve a generation_jobs.provider mezőben. */
export const MOCK_PROVIDER = 'mock';

/** A Mock provider source_label értéke (a 008-as migráció adja hozzá). */
export const MOCK_SOURCE_LABEL = 'mock';

/** A valódi Premium provider source_label értéke. */
export const FAL_SOURCE_LABEL = 'ai_generated';

/** A felhasználónak megjelenő Premium címke. */
export const PREMIUM_LABEL = 'Prémium AI felvétel';

/** A felhasználónak megjelenő Mock címke (jól látható MOCK / TESZT jelölés). */
export const MOCK_LABEL = 'MOCK / TESZT — tesztanyag, nem valós AI-kimenet';

/** A Stock helyettesítő felvétel címkéje (a Premium felvétel helyett). */
export const STOCK_FALLBACK_LABEL = 'Stock helyettesítő';

/** Az egész projektre vonatkozó, őszinte előnézeti címke. */
export const PREVIEW_LABEL = 'Animatic / előnézet';

/** A Mock provider szimulált költsége (nem valós kiadás, külön számolva). */
export const MOCK_SIMULATED_COST_USD = 0;

/** A Premium konfiguráció állapota. */
export type PremiumConfigStatus = 'unconfigured' | 'mock' | 'real';

/** A Premium konfiguráció állapotát adja vissza a szerveroldali kulcs alapján. */
export function getPremiumConfigStatus(falKey: string | null | undefined): PremiumConfigStatus {
  const key = (falKey ?? '').trim();
  if (!key) return 'mock';
  return 'real';
}

/** Igaz, ha az adott lépéshez van ellenőrzött endpoint ÉS ellenőrzött ár. */
export function isStepConfigured(step: PremiumStep): boolean {
  const cfg = FAL_ENDPOINTS[step];
  return Boolean(cfg.endpointId && cfg.unitPriceUsd !== null);
}

/**
 * A legközelebbi támogatott időtartam a kívánt másodperchez.
 * Csak olyan értéket ad vissza, amely NEM rövidebb a kívántnál.
 * Ha nincs ilyen, null (a felvétel `needs_review` állapotba kerül).
 */
export function pickSupportedDuration(
  step: PremiumStep,
  desiredSeconds: number
): number | null {
  const durations = FAL_ENDPOINTS[step].supportedDurationsSec;
  if (!durations || durations.length === 0) return null;
  const desired = Number(desiredSeconds);
  if (!Number.isFinite(desired) || desired <= 0) return null;
  const suitable = durations.filter((d) => d >= desired).sort((a, b) => a - b);
  return suitable.length > 0 ? suitable[0] : null;
}

/**
 * A lépés becsült költsége USD-ben.
 * `null` = ismeretlen ár (a UI "ismeretlen"-t mutat, a valódi provider tiltva marad).
 */
export function estimateStepCostUsd(
  step: PremiumStep,
  options: { durationSec?: number; megapixels?: number; units?: number } = {}
): number | null {
  const cfg = FAL_ENDPOINTS[step];
  if (cfg.unitPriceUsd === null) return null;

  switch (cfg.billingUnit) {
    case 'seconds': {
      const seconds = Number(options.durationSec ?? 0);
      if (!Number.isFinite(seconds) || seconds <= 0) return null;
      return round4(cfg.unitPriceUsd * seconds);
    }
    case 'megapixels': {
      const megapixels = Number(options.megapixels ?? 0);
      if (!Number.isFinite(megapixels) || megapixels <= 0) return null;
      return round4(cfg.unitPriceUsd * megapixels);
    }
    case 'units': {
      const units = Number(options.units ?? 0);
      if (!Number.isFinite(units) || units <= 0) return null;
      return round4(cfg.unitPriceUsd * units);
    }
    default:
      return null;
  }
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
