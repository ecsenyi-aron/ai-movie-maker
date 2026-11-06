/**
 * Agent 4 — Prémium provider absztrakció.
 *
 * Két provider implementáció:
 * - `MockProvider`: ingyenes, kulcs nélkül fut, ugyanazt a munkafolyamatot
 *   hajtja végre (job, állapotok, tárolás, idővonal), csak a külső hívást
 *   szimulálja. A kimenete SOHA nem valódi AI videó.
 * - `FalProvider`: a valódi fal.ai Queue API (hivatalos dokumentáció alapján).
 *
 * A provider független a munkafolyamattól: a Premium workflow ugyanazt a
 * kódot használja mindkettőhöz.
 */

import {
  FAL_ENDPOINTS,
  FAL_QUEUE_BASE_URL,
  FAL_QUEUE_PATHS,
  MOCK_PROVIDER,
  MOCK_SOURCE_LABEL,
  FAL_PROVIDER,
  FAL_SOURCE_LABEL,
  type PremiumStep,
} from './agent4-premium-config.ts';

/** A provider által támogatott lépések. */
export type ProviderStep = PremiumStep;

/** Egy provider-hívás eredménye (submit). */
export interface ProviderSubmitOutcome {
  ok: boolean;
  /** A provider oldali feladatazonosító (a queue request_id). */
  providerJobId?: string;
  /** Magyar hibaüzenet (titok nélkül). */
  error?: string;
  /** Igaz, ha a szolgáltató túl sok kérést kapott (429). */
  tooManyRequests?: boolean;
  /** Igaz, ha a kimenet bizonytalan (időtúllépés): egyeztetés kell. */
  uncertain?: boolean;
}

/** Egy provider-hívás eredménye (poll). */
export interface ProviderPollOutcome {
  /** 'pending' | 'processing' | 'succeeded' | 'failed' */
  status: 'pending' | 'processing' | 'succeeded' | 'failed';
  /** A kész fájl URL-je (ha van). */
  outputUrl?: string;
  /** A kész fájl tartalma (Mock provider esetén). */
  outputBytes?: Uint8Array;
  /** A kész fájl MIME-típusa. */
  outputContentType?: string;
  /** Magyar hibaüzenet. */
  error?: string;
  /** Igaz, ha a szolgáltató túl sok kérést kapott (429). */
  tooManyRequests?: boolean;
}

/**
 * Egy további referencia elem a videó kéréshez.
 *
 * A fal.ai Kling v3 API `elements` tömbjének egy eleme
 * (`KlingV3ComboElementInput`): az elem elölnézete és opcionális
 * további nézetei.
 */
export interface ProviderVideoElement {
  /** Az elem elölnézete (a fő kép). */
  frontalImageUrl: string;
  /** További nézetek az elemről (a hivatalos séma szerint 1–3 db). */
  referenceImageUrls?: string[];
}

/**
 * A `elements` tömb felépítése a hivatalos `KlingV3ComboElementInput` séma
 * szerint:
 * - `frontal_image_url`: az elem elölnézete (mindig megvan),
 * - `reference_image_urls`: további nézetek (legfeljebb 3 db).
 *
 * A `start_image_url` kötelező mező marad: az a videó kezdőképe.
 */
export function buildVideoElements(
  elements: ProviderVideoElement[] | undefined
): Array<{ frontal_image_url: string; reference_image_urls?: string[] }> {
  return (elements ?? [])
    .map((element) => {
      const frontal = (element.frontalImageUrl ?? '').trim();
      if (!frontal) return null;
      const extra = (element.referenceImageUrls ?? [])
        .map((url) => url.trim())
        .filter((url) => url.length > 0)
        .slice(0, 3);
      return extra.length > 0
        ? { frontal_image_url: frontal, reference_image_urls: extra }
        : { frontal_image_url: frontal };
    })
    .filter(
      (element): element is { frontal_image_url: string; reference_image_urls?: string[] } =>
        element !== null
    );
}

/** A provider közös interfésze. */
export interface PremiumProvider {
  /** A provider neve a generation_jobs.provider mezőben. */
  readonly id: string;
  /** A media_assets.source_label értéke. */
  readonly sourceLabel: string;
  /** Igaz, ha a költségek csak szimuláltak (nem valós kiadás). */
  readonly simulated: boolean;
  /** Referencia kép indítása. */
  submitReferenceImage(input: { prompt: string }): Promise<ProviderSubmitOutcome>;
  /** Képből videó indítása. */
  submitVideo(input: {
    prompt: string;
    imageUrl: string;
    durationSec: number;
    /** További referenciák (a `elements` tömbbe kerülnek). */
    elements?: ProviderVideoElement[];
  }): Promise<ProviderSubmitOutcome>;
  /** Lip-sync indítása. */
  submitLipsync(input: {
    videoUrl: string;
    audioUrl: string;
  }): Promise<ProviderSubmitOutcome>;
  /** A provider feladatának állapota. */
  poll(step: ProviderStep, providerJobId: string): Promise<ProviderPollOutcome>;
}

// ---------------------------------------------------------------------------
// Mock provider
// ---------------------------------------------------------------------------

/** A Mock provider kimeneteinek determinisztikus sorsa (tesztekhez). */
export type MockOutcome = 'success' | 'failed' | 'uncertain';

/** A Mock provider opciói. */
export interface MockProviderOptions {
  /** Az egyes lépések kimenete (tesztekben felülírható). */
  outcomes?: Partial<Record<ProviderStep, MockOutcome>>;
  /** A referencia kép fixture tartalma. */
  referenceImageBytes?: Uint8Array;
  /** A videó fixture tartalma. */
  videoBytes?: Uint8Array;
}

/** A Mock provider által használt fixture-ök (a repóban, `fixtures/` mappában). */
const MOCK_REFERENCE_IMAGE_FIXTURE = 'src/lib/agents/fixtures/mock-reference.png';
const MOCK_VIDEO_FIXTURE = 'src/lib/agents/fixtures/mock-video.mp4';

/** A fixture-ek betöltése a lemezről (szerveroldalon). */
function loadFixture(relativePath: string): Uint8Array | null {
  try {
    // A Node fs modul csak szerveroldalon fut; dinamikus import a kliens miatt.
    const req = eval('require') as NodeRequire;
    const fs = req('fs') as typeof import('fs');
    const path = req('path') as typeof import('path');
    const file = path.join(process.cwd(), relativePath);
    return new Uint8Array(fs.readFileSync(file));
  } catch {
    return null;
  }
}

/**
 * Ingyenes, kulcs nélküli provider.
 *
 * Ugyanazt a munkafolyamatot hajtja végre, mint a valódi provider: a
 * `submit` azonnal ad egy provider_job_id-t, a `poll` pedig ugyanazt a
 * kimeneti szerkezetet adja, mint a fal.ai (URL vagy nyers bájtok).
 */
export class MockProvider implements PremiumProvider {
  readonly id = MOCK_PROVIDER;
  readonly sourceLabel = MOCK_SOURCE_LABEL;
  readonly simulated = true;

  private readonly outcomes: Partial<Record<ProviderStep, MockOutcome>>;
  private readonly referenceImageBytes?: Uint8Array;
  private readonly videoBytes?: Uint8Array;

  constructor(options: MockProviderOptions = {}) {
    this.outcomes = options.outcomes ?? {};
    this.referenceImageBytes = options.referenceImageBytes;
    this.videoBytes = options.videoBytes;
  }

  private outcomeFor(step: ProviderStep): MockOutcome {
    return this.outcomes[step] ?? 'success';
  }

  private jobId(step: ProviderStep, seed: string): string {
    // Determinisztikus azonosító: nincs véletlen, nincs időbélyeg.
    let hash = 0;
    for (let i = 0; i < seed.length; i += 1) {
      hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
    }
    return `mock-${step}-${hash.toString(16)}`;
  }

  async submitReferenceImage(input: { prompt: string }): Promise<ProviderSubmitOutcome> {
    const outcome = this.outcomeFor('reference_image');
    if (outcome === 'failed') {
      return { ok: false, error: 'A MOCK provider szimulált hibája (referencia kép).' };
    }
    if (outcome === 'uncertain') {
      return {
        ok: false,
        uncertain: true,
        providerJobId: this.jobId('reference_image', input.prompt),
        error: 'A MOCK provider bizonytalan kimenetet szimulál (referencia kép).',
      };
    }
    return { ok: true, providerJobId: this.jobId('reference_image', input.prompt) };
  }

  async submitVideo(input: {
    prompt: string;
    imageUrl: string;
    durationSec: number;
    elements?: ProviderVideoElement[];
  }): Promise<ProviderSubmitOutcome> {
    const outcome = this.outcomeFor('video');
    if (outcome === 'failed') {
      return { ok: false, error: 'A MOCK provider szimulált hibája (videó).' };
    }
    if (outcome === 'uncertain') {
      return {
        ok: false,
        uncertain: true,
        providerJobId: this.jobId('video', `${input.prompt}|${input.durationSec}`),
        error: 'A MOCK provider bizonytalan kimenetet szimulál (videó).',
      };
    }
    return {
      ok: true,
      providerJobId: this.jobId('video', `${input.prompt}|${input.durationSec}`),
    };
  }

  async submitLipsync(input: {
    videoUrl: string;
    audioUrl: string;
  }): Promise<ProviderSubmitOutcome> {
    const outcome = this.outcomeFor('lipsync');
    if (outcome === 'failed') {
      return { ok: false, error: 'A MOCK provider szimulált hibája (lip-sync).' };
    }
    if (outcome === 'uncertain') {
      return {
        ok: false,
        uncertain: true,
        providerJobId: this.jobId('lipsync', `${input.videoUrl}|${input.audioUrl}`),
        error: 'A MOCK provider bizonytalan kimenetet szimulál (lip-sync).',
      };
    }
    return {
      ok: true,
      providerJobId: this.jobId('lipsync', `${input.videoUrl}|${input.audioUrl}`),
    };
  }

  async poll(step: ProviderStep, providerJobId: string): Promise<ProviderPollOutcome> {
    const outcome = this.outcomeFor(step);
    if (outcome === 'failed') {
      return {
        status: 'failed',
        error: `A MOCK provider szimulált hibája (poll: ${providerJobId}).`,
      };
    }
    if (outcome === 'uncertain') {
      return {
        status: 'processing',
        error: `A MOCK provider bizonytalan kimenetet szimulál (poll: ${providerJobId}).`,
      };
    }

    if (step === 'reference_image') {
      const bytes =
        this.referenceImageBytes ?? loadFixture(MOCK_REFERENCE_IMAGE_FIXTURE);
      if (!bytes) {
        return {
          status: 'failed',
          error: 'A MOCK referencia kép fixture nem található a repóban.',
        };
      }
      return {
        status: 'succeeded',
        outputBytes: bytes,
        outputContentType: 'image/png',
      };
    }

    const bytes = this.videoBytes ?? loadFixture(MOCK_VIDEO_FIXTURE);
    if (!bytes) {
      return {
        status: 'failed',
        error: 'A MOCK videó fixture nem található a repóban.',
      };
    }
    return {
      status: 'succeeded',
      outputBytes: bytes,
      outputContentType: 'video/mp4',
    };
  }
}

// ---------------------------------------------------------------------------
// fal.ai provider
// ---------------------------------------------------------------------------

/** A fal.ai provider opciói. */
export interface FalProviderOptions {
  /** A fal.ai kulcs (szerveroldali környezeti változóból). */
  apiKey: string;
  /** A HTTP kliens (teszthez felülírható). */
  fetchImpl?: typeof fetch;
  /** A kérés időtúllépése ms-ben. */
  timeoutMs?: number;
  /** A 429 utáni várakozás ms-ben (egy visszhang). */
  backoffMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_BACKOFF_MS = 2_000;

/** A fal.ai Queue API alapú provider. */
export class FalProvider implements PremiumProvider {
  readonly id = FAL_PROVIDER;
  readonly sourceLabel = FAL_SOURCE_LABEL;
  readonly simulated = false;

  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly backoffMs: number;

  constructor(options: FalProviderOptions) {
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  }

  /** A hitelesítési fejléc (hivatalos dokumentáció: "Authorization: Key $FAL_KEY"). */
  private headers(): Record<string, string> {
    return {
      Authorization: `Key ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  private endpointUrl(endpointId: string, suffix = ''): string {
    return `${FAL_QUEUE_BASE_URL}/${endpointId}${suffix}`;
  }

  /** Egy POST kérés a queue-hoz, 429 esetén egyszeri visszhanggal. */
  private async postWithBackoff(
    endpointId: string,
    body: Record<string, unknown>
  ): Promise<ProviderSubmitOutcome> {
    const url = this.endpointUrl(endpointId, FAL_QUEUE_PATHS.submit);
    let retried = false;

    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(url, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(body),
          signal: controller.signal,
          cache: 'no-store',
        });

        if (response.status === 429) {
          if (retried) {
            return {
              ok: false,
              tooManyRequests: true,
              error: 'A fal.ai túl sok kérést kapott (429). Próbáld később.',
            };
          }
          retried = true;
          await delay(this.backoffMs);
          continue;
        }

        if (!response.ok) {
          return {
            ok: false,
            error: `A fal.ai kérés nem sikerült (HTTP ${response.status}).`,
          };
        }

        const payload = (await response.json().catch(() => null)) as {
          request_id?: string;
          status?: string;
        } | null;

        if (!payload?.request_id) {
          return {
            ok: false,
            uncertain: true,
            error: 'A fal.ai válaszából hiányzik a request_id: a kimenet nem tisztázható.',
          };
        }

        return { ok: true, providerJobId: payload.request_id };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'hálózati hiba';
        return {
          ok: false,
          uncertain: true,
          error: `A fal.ai kérés bizonytalan eredményű: ${message}`,
        };
      } finally {
        clearTimeout(timer);
      }
    }
  }

  async submitReferenceImage(input: { prompt: string }): Promise<ProviderSubmitOutcome> {
    const cfg = FAL_ENDPOINTS.reference_image;
    return this.postWithBackoff(cfg.endpointId, {
      prompt: input.prompt,
      image_size: 'landscape_4_3',
      width: 1280,
      height: 720,
      num_images: 1,
      enable_safety_checker: true,
    });
  }

  async submitVideo(input: {
    prompt: string;
    imageUrl: string;
    durationSec: number;
    elements?: ProviderVideoElement[];
  }): Promise<ProviderSubmitOutcome> {
    const cfg = FAL_ENDPOINTS.video;
    const body: Record<string, unknown> = {
      prompt: input.prompt,
      start_image_url: input.imageUrl,
      duration: String(input.durationSec),
      enable_safety_checker: true,
      // A hivatalos API alapértelmezett értéke; a felvétel kézzel felépített.
      shot_type: 'customize',
    };
    // Multi-reference: a további képek az `elements` tömbben mennek, és a
    // promptban @Element1, @Element2 formában hivatkozhatók rájuk.
    const elements = buildVideoElements(input.elements);
    if (elements.length > 0) body.elements = elements;
    return this.postWithBackoff(cfg.endpointId, body);
  }

  async submitLipsync(input: {
    videoUrl: string;
    audioUrl: string;
  }): Promise<ProviderSubmitOutcome> {
    const cfg = FAL_ENDPOINTS.lipsync;
    return this.postWithBackoff(cfg.endpointId, {
      video_url: input.videoUrl,
      audio_url: input.audioUrl,
      enable_safety_checker: true,
    });
  }

  async poll(step: ProviderStep, providerJobId: string): Promise<ProviderPollOutcome> {
    const cfg = FAL_ENDPOINTS[step];
    const statusUrl = this.endpointUrl(
      cfg.endpointId,
      FAL_QUEUE_PATHS.status.replace('{request_id}', encodeURIComponent(providerJobId))
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let statusPayload: { status?: string } | null = null;
    try {
      const response = await this.fetchImpl(statusUrl, {
        method: 'GET',
        headers: this.headers(),
        signal: controller.signal,
        cache: 'no-store',
      });

      if (response.status === 429) {
        return {
          status: 'processing',
          tooManyRequests: true,
          error: 'A fal.ai túl sok kérést kapott (429). Próbáld később.',
        };
      }
      if (!response.ok) {
        return {
          status: 'failed',
          error: `A fal.ai állapotlekérdezés nem sikerült (HTTP ${response.status}).`,
        };
      }
      statusPayload = (await response.json().catch(() => null)) as { status?: string } | null;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'hálózati hiba';
      return {
        status: 'processing',
        error: `A fal.ai állapotlekérdezés bizonytalan: ${message}`,
      };
    } finally {
      clearTimeout(timer);
    }

    const status = statusPayload?.status;
    if (status === 'IN_QUEUE') return { status: 'pending' };
    if (status === 'IN_PROGRESS') return { status: 'processing' };
    if (status !== 'COMPLETED') {
      return {
        status: 'failed',
        error: `Ismeretlen fal.ai állapot: ${status ?? 'nincs'}.`,
      };
    }

    // Kész: a tényleges eredmény lekérése.
    const resultUrl = this.endpointUrl(
      cfg.endpointId,
      FAL_QUEUE_PATHS.result.replace('{request_id}', encodeURIComponent(providerJobId))
    );

    const resultController = new AbortController();
    const resultTimer = setTimeout(() => resultController.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(resultUrl, {
        method: 'GET',
        headers: this.headers(),
        signal: resultController.signal,
        cache: 'no-store',
      });
      if (!response.ok) {
        return {
          status: 'failed',
          error: `A fal.ai eredmény lekérése nem sikerült (HTTP ${response.status}).`,
        };
      }
      const result = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      const url = extractOutputUrl(step, result);
      if (!url) {
        return {
          status: 'failed',
          error: 'A fal.ai eredményében nem található a kész fájl URL-je.',
        };
      }
      return { status: 'succeeded', outputUrl: url };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'hálózati hiba';
      return {
        status: 'processing',
        error: `A fal.ai eredmény lekérése bizonytalan: ${message}`,
      };
    } finally {
      clearTimeout(resultTimer);
    }
  }
}

/** A kész fájl URL-jének kinyerése a hivatalos kimeneti sémák alapján. */
function extractOutputUrl(
  step: ProviderStep,
  result: Record<string, unknown> | null
): string | null {
  if (!result) return null;

  if (step === 'reference_image') {
    const images = result.images;
    if (Array.isArray(images) && images.length > 0) {
      const first = images[0] as { url?: string } | undefined;
      if (first?.url) return first.url;
    }
    return null;
  }

  const video = result.video;
  if (video && typeof video === 'object') {
    const url = (video as { url?: string }).url;
    if (url) return url;
  }
  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
