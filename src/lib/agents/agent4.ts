/**
 * Agent 4 — Stock felvétel gyűjtése (kód, nem LLM).
 * Csak a "Stock" mód (Mode A) készült el; a Prémium mód nincs ebben a modulban.
 *
 * Az `advance()` PONTOSAN EGY rövid lépést végez, és magyar státuszt ad vissza.
 * A titkok (Pixabay-kulcs, service role kulcs) csak szerveroldalon léteznek.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { isUniqueViolation, sortShots } from './agent3-helpers.ts';
import {
  buildAttribution,
  extractKeywords,
  pickClip,
  validateDownload,
  type PixabayHit,
} from './agent4-stock.ts';

/** A felhasználónak megjelenő címke. */
export const AGENT4_LABEL = 'Stock / könyvtári felvétel';

export const MEDIA_BUCKET = 'media';
const PIXABAY_SEARCH_URL = 'https://pixabay.com/api/videos/';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SEARCH_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const PER_PAGE = 20;

const NO_CLIP_NOTE =
  'Nincs megfelelő stock felvétel. Helyettesítő képkocka/szövegkártya később.';
const PLACEHOLDER_NOTE =
  'Helyettesítő felvétel: a szereplő és a helyszín nem biztosan egyezik.';

export interface Agent4Result {
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
}

/** A `shots` tábla sorainak a modulban használt mezői. */
export interface ShotRow {
  id: string;
  scene_id: string;
  number: number;
  visual_prompt_en: string;
  target_duration_sec: number | null;
  actual_duration_sec: number | null;
  status: string;
  qc_notes: string | null;
}

/** A `generation_jobs` tábla sorainak a modulban használt mezői. */
interface JobRow {
  id: string;
  shot_id: string | null;
  attempt: number;
  status: string;
  error: string | null;
}

/** A `media_assets` tábla sorainak a modulban használt mezői. */
interface AssetRow {
  id: string;
  shot_id: string | null;
  storage_path: string;
  provider: string | null;
  attribution: string | null;
  duration_sec: number | null;
}

/** Felvétel film sorrendben, a globális sorszámmal. */
export type OrderedShot = ShotRow & { position: number };

function fail(step: string, error?: unknown): Agent4Result {
  const detail =
    error instanceof Error && error.message
      ? error.message
      : typeof error === 'string' && error
        ? error
        : 'ismeretlen ok';
  return { success: false, message: `Hiba történt: ${step}. (${detail})` };
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** A Pixabay keresési kulcs: stabil, azonos kulcsszavakhoz azonos. */
function cacheKeyFor(keywords: string): string {
  return `pixabay:videos:${keywords.toLowerCase()}`;
}

/** Szélesebb keresés: kevesebb kulcsszó. */
function broaderKeywords(keywords: string): string {
  const parts = keywords.split(' ').filter(Boolean);
  if (parts.length <= 1) return '';
  return parts.slice(0, Math.max(1, parts.length - 2)).join(' ');
}

export interface SearchOutcome {
  ok: boolean;
  hits: PixabayHit[];
  /** 'cache' | 'network' */
  source: 'cache' | 'network';
  error?: string;
  /** Igaz, ha a rate limit elfogyott (X-RateLimit-Remaining: 0). */
  rateLimited?: boolean;
  /** Igaz, ha a Pixabay 429-et adott. */
  tooManyRequests?: boolean;
}

/**
 * Keresés a Pixabay-on, 24 órás adatbázis-gyorsítótárral.
 * Az API-kulcs és a kulcsot tartalmazó URL soha nem kerül naplóba.
 */
export async function searchPixabay(
  adminClient: SupabaseClient,
  apiKey: string,
  keywords: string
): Promise<SearchOutcome> {
  const queryKey = cacheKeyFor(keywords);

  // --- gyorsítótár ---
  const { data: cached, error: cacheErr } = await adminClient
    .from('stock_search_cache')
    .select('response, fetched_at')
    .eq('query_key', queryKey)
    .maybeSingle();

  if (cacheErr) {
    return { ok: false, hits: [], source: 'cache', error: 'a gyorsítótár betöltése' };
  }

  if (cached) {
    const fetchedAt = new Date(cached.fetched_at as string).getTime();
    const age = Date.now() - fetchedAt;
    if (Number.isFinite(fetchedAt) && age >= 0 && age < CACHE_TTL_MS) {
      const response = cached.response as { hits?: PixabayHit[] } | null;
      return { ok: true, hits: response?.hits ?? [], source: 'cache' };
    }
  }

  // --- hálózati hívás ---
  const url = new URL(PIXABAY_SEARCH_URL);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('q', keywords);
  url.searchParams.set('per_page', String(PER_PAGE));
  url.searchParams.set('safesearch', 'true');
  url.searchParams.set('order', 'popular');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch (err) {
    return {
      ok: false,
      hits: [],
      source: 'network',
      error: err instanceof Error ? err.message : 'hálózati hiba',
    };
  } finally {
    clearTimeout(timer);
  }

  const remaining = response.headers.get('x-ratelimit-remaining');
  if (remaining !== null && Number(remaining) <= 0) {
    return { ok: false, hits: [], source: 'network', rateLimited: true };
  }

  if (response.status === 429) {
    return { ok: false, hits: [], source: 'network', tooManyRequests: true };
  }

  if (!response.ok) {
    return {
      ok: false,
      hits: [],
      source: 'network',
      error: `HTTP ${response.status}`,
    };
  }

  let payload: { hits?: PixabayHit[] };
  try {
    payload = (await response.json()) as { hits?: PixabayHit[] };
  } catch (err) {
    return {
      ok: false,
      hits: [],
      source: 'network',
      error: err instanceof Error ? err.message : 'érvénytelen JSON',
    };
  }

  const hits = Array.isArray(payload?.hits) ? payload.hits : [];

  // --- gyorsítótár feltöltése ---
  const { error: storeErr } = await adminClient
    .from('stock_search_cache')
    .upsert(
      { query_key: queryKey, response: payload, fetched_at: new Date().toISOString() },
      { onConflict: 'query_key' }
    );
  if (storeErr) {
    return {
      ok: false,
      hits: [],
      source: 'network',
      error: 'a keresési gyorsítótár mentése',
    };
  }

  return { ok: true, hits, source: 'network' };
}

/** Letölti a klipet. Időtúllépés = bizonytalan kimenet. */
export async function downloadClip(
  url: string
): Promise<
  | { ok: true; bytes: Uint8Array; contentType: string; contentLength: number | null }
  | { ok: false; uncertain: boolean; error: string }
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: 'GET', signal: controller.signal });
    if (!response.ok) {
      return {
        ok: false,
        uncertain: false,
        error: `a letöltés nem sikerült (HTTP ${response.status})`,
      };
    }
    const contentType = response.headers.get('content-type') ?? '';
    const lengthHeader = response.headers.get('content-length');
    const contentLength = lengthHeader ? Number(lengthHeader) : null;
    const buffer = await response.arrayBuffer();
    return {
      ok: true,
      bytes: new Uint8Array(buffer),
      contentType,
      contentLength: Number.isFinite(contentLength as number) ? contentLength : null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'hálózati hiba';
    return { ok: false, uncertain: true, error: message };
  } finally {
    clearTimeout(timer);
  }
}

/** Van-e már elmentett fájl a felvétel mappájában? */
async function storageFolderHasFile(
  adminClient: SupabaseClient,
  projectId: string,
  shotId: string
): Promise<boolean> {
  try {
    const { data, error } = await adminClient.storage
      .from(MEDIA_BUCKET)
      .list(`${projectId}/${shotId}`);
    if (error) return false;
    return Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}

/**
 * Agent 4 — egyetlen rövid lépés.
 *
 * @param userClient a bejelentkezett felhasználó kliensje (RLS) — tulajdonjog
 * @param adminClient a szerveroldali privilegizált kliens
 * @param projectId a projekt azonosítója
 */
export async function advance(
  userClient: SupabaseClient,
  adminClient: SupabaseClient,
  projectId: string,
  options: { forceShotId?: string } = {}
): Promise<Agent4Result> {
  try {
    // ------------------------------------------------------------------
    // 1. Előfeltételek: bejelentkezés + tulajdonjog (a FELHASZNÁLÓI klienssel)
    // ------------------------------------------------------------------
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) {
      return { success: false, message: 'Nincs érvényes bejelentkezés.' };
    }

    const { data: ownedProject, error: ownedErr } = await userClient
      .from('projects')
      .select('id, user_id')
      .eq('id', projectId)
      .eq('user_id', userData.user.id)
      .maybeSingle();

    if (ownedErr) {
      return fail('a projekt tulajdonjogának ellenőrzése', ownedErr);
    }
    if (!ownedProject) {
      return { success: false, message: 'Nincs jogosultságod ehhez a projekthez.' };
    }

    // ------------------------------------------------------------------
    // 2. A projekt állapota (privilegizált kliens)
    // ------------------------------------------------------------------
    const { data: project, error: projectErr } = await adminClient
      .from('projects')
      .select('id, approved_at, mode, status')
      .eq('id', projectId)
      .maybeSingle();

    if (projectErr) return fail('a projekt betöltése', projectErr);
    if (!project) {
      return { success: false, message: 'A megadott projekt nem található.' };
    }
    if (!project.approved_at) {
      return {
        success: false,
        message: 'A projekt még nincs jóváhagyva, ezért a stock felvételek gyűjtése nem indítható.',
      };
    }
    // A Prémium projektben a Stock mód csak manuális "Stock helyettesítő"
    // lépésként indítható egy adott felvételre (forceShotId).
    const forcedShotId = options.forceShotId ?? null;
    if (project.mode !== 'stock' && !forcedShotId) {
      return {
        success: false,
        message: 'Ez a projekt nem Stock módban van, ezért a könyvtári felvételek gyűjtése nem indítható.',
      };
    }

    // ------------------------------------------------------------------
    // 3. Egyszerre csak egy futó feladat lehet projektenként
    // ------------------------------------------------------------------
    const { data: runningJobs, error: runningErr } = await adminClient
      .from('generation_jobs')
      .select('id, status')
      .eq('project_id', projectId)
      .in('status', ['pending', 'submitted', 'processing']);

    if (runningErr) return fail('a futó feladatok betöltése', runningErr);
    if ((runningJobs ?? []).length > 0) {
      return { success: false, message: 'folyamatban' };
    }

    // ------------------------------------------------------------------
    // 4. Adatok betöltése
    // ------------------------------------------------------------------
    const { data: sceneRows, error: sceneErr } = await adminClient
      .from('scenes')
      .select('id, number')
      .eq('project_id', projectId);
    if (sceneErr) return fail('a jelenetek betöltése', sceneErr);

    const scenes = (sceneRows ?? []) as Array<{ id: string; number: number }>;
    const sceneIds = scenes.map((s) => s.id);

    let shotRows: ShotRow[] = [];
    if (sceneIds.length > 0) {
      const { data, error } = await adminClient
        .from('shots')
        .select(
          'id, scene_id, number, visual_prompt_en, target_duration_sec, actual_duration_sec, status, qc_notes'
        )
        .in('scene_id', sceneIds);
      if (error) return fail('a felvételek betöltése', error);
      shotRows = (data ?? []) as ShotRow[];
    }

    const orderedShots = sortShots(scenes, shotRows) as OrderedShot[];

    const { data: jobRows, error: jobErr } = await adminClient
      .from('generation_jobs')
      .select('id, shot_id, attempt, status, error')
      .eq('project_id', projectId)
      .eq('step', 'stock');
    if (jobErr) return fail('a stock feladatok betöltése', jobErr);
    const jobs = (jobRows ?? []) as JobRow[];

    const { data: assetRows, error: assetErr } = await adminClient
      .from('media_assets')
      .select('id, shot_id, storage_path, provider, attribution, duration_sec')
      .eq('project_id', projectId)
      .eq('type', 'video');
    if (assetErr) return fail('a médiafájlok betöltése', assetErr);
    const assets = (assetRows ?? []) as AssetRow[];

    const { data: characterRows, error: characterErr } = await adminClient
      .from('characters')
      .select('id')
      .eq('project_id', projectId);
    if (characterErr) return fail('a szereplők betöltése', characterErr);
    const hasCharacters = (characterRows ?? []).length > 0;

    // ------------------------------------------------------------------
    // 5. Bizonytalan kimenetek egyeztetése (előbb mindig ez történik)
    // ------------------------------------------------------------------
    const uncertainJobs = jobs.filter((j) => j.status === 'uncertain');
    for (const job of uncertainJobs) {
      if (!job.shot_id) continue;
      const existingAsset = assets.find(
        (a) => a.shot_id === job.shot_id && a.provider === 'pixabay'
      );
      if (existingAsset) {
        const { error } = await adminClient
          .from('generation_jobs')
          .update({ status: 'succeeded', error: null })
          .eq('id', job.id);
        if (error) return fail('a bizonytalan feladat egyeztetése', error);
        return {
          success: true,
          message: 'A korábbi bizonytalan stock feladat egyeztetve: a fájl már elmentve volt.',
          data: { shotId: job.shot_id, reconciled: true },
        };
      }

      const hasFile = await storageFolderHasFile(adminClient, projectId, job.shot_id);
      if (hasFile) {
        const { error } = await adminClient
          .from('generation_jobs')
          .update({
            status: 'failed',
            error:
              'A bizonytalan kimenet nem egyeztethető össze automatikusan: a fájl megvan, de nincs hozzá media_assets sor.',
          })
          .eq('id', job.id);
        if (error) return fail('a bizonytalan feladat egyeztetése', error);
        return {
          success: false,
          message:
            'A korábbi bizonytalan stock feladat nem egyeztethető össze automatikusan. Kérj technikai segítséget.',
          data: { shotId: job.shot_id, reconciled: true },
        };
      }

      const { error } = await adminClient
        .from('generation_jobs')
        .update({
          status: 'failed',
          error: 'A bizonytalan kimenet után nem maradt elmentett fájl.',
        })
        .eq('id', job.id);
      if (error) return fail('a bizonytalan feladat egyeztetése', error);
      return {
        success: true,
        message: 'A korábbi bizonytalan stock feladat lezárva: nem maradt elmentett fájl.',
        data: { shotId: job.shot_id, reconciled: true },
      };
    }

    // ------------------------------------------------------------------
    // 6. A következő felvétel kiválasztása (film sorrendben)
    // ------------------------------------------------------------------
    const succeededShotIds = new Set(
      jobs.filter((j) => j.status === 'succeeded' && j.shot_id).map((j) => j.shot_id)
    );

    const nextShot = forcedShotId
      ? orderedShots.find((shot: OrderedShot) => {
          if (shot.id !== forcedShotId) return false;
          if (succeededShotIds.has(shot.id)) return false;
          // A kényszerített helyettesítő csak egy sikertelen felvételre futhat.
          return shot.status === 'needs_review' || shot.status === 'audio_ready';
        })
      : orderedShots.find((shot: OrderedShot) => {
          if (succeededShotIds.has(shot.id)) return false;
          if (shot.status === 'audio_ready') return true;
          // Újrapróbálás: csak sikertelen stock feladat után, legfeljebb egyszer.
          if (shot.status === 'needs_review') {
            const failedAttempts = jobs.filter(
              (j) => j.shot_id === shot.id && j.status === 'failed'
            ).length;
            return failedAttempts > 0 && failedAttempts < 2;
          }
          return false;
        });

    if (!nextShot) {
      return { success: true, message: 'nincs több teendő' };
    }

    const shotId: string = nextShot.id;
    const neededSeconds = num(nextShot.actual_duration_sec) || num(nextShot.target_duration_sec);

    // ------------------------------------------------------------------
    // 7. A projekt állapota: approved -> generating
    // ------------------------------------------------------------------
    if (project.status === 'approved') {
      const { error } = await adminClient
        .from('projects')
        .update({ status: 'generating' })
        .eq('id', projectId);
      if (error) return fail('a projekt állapotának frissítése', error);
    }

    // ------------------------------------------------------------------
    // 8. A generation_jobs sor LÉTREHOZÁSA a hálózati hívás előtt
    // ------------------------------------------------------------------
    const previousAttempts = jobs
      .filter((j) => j.shot_id === shotId)
      .map((j) => num(j.attempt) || 1);
    const attempt = previousAttempts.length > 0 ? Math.max(...previousAttempts) + 1 : 1;

    const { data: createdJob, error: jobInsertErr } = await adminClient
      .from('generation_jobs')
      .insert({
        project_id: projectId,
        shot_id: shotId,
        provider: 'pixabay',
        step: 'stock',
        attempt,
        prompt: nextShot.visual_prompt_en ?? '',
        status: 'pending',
        estimated_cost_usd: 0,
        reserved_cost_usd: 0,
        actual_cost_usd: 0,
        error: null,
      })
      .select('id')
      .single();

    if (jobInsertErr) {
      if (isUniqueViolation(jobInsertErr)) {
        // Egyedi kulcsütközés: NEM általános hiba, hanem a már meglévő job.
        const { data: existingJob, error: existingJobErr } = await adminClient
          .from('generation_jobs')
          .select('id, status')
          .eq('shot_id', shotId)
          .eq('provider', 'pixabay')
          .eq('step', 'stock')
          .eq('attempt', attempt)
          .maybeSingle();

        if (existingJobErr) {
          return fail('a meglévő stock feladat betöltése', existingJobErr);
        }

        if (!existingJob) {
          return {
            success: false,
            message: 'Ez a felvételhez már létezik egy stock feladat (már létezik).',
          };
        }

        const existingStatus = String((existingJob as { status?: string }).status ?? '');
        if (['pending', 'submitted', 'processing'].includes(existingStatus)) {
          return { success: false, message: 'folyamatban' };
        }

        return {
          success: false,
          message: 'Ez a felvételhez már létezik egy stock feladat (már létezik).',
          data: { shotId, existingJob: true },
        };
      }
      return fail('a stock feladat létrehozása', jobInsertErr);
    }

    const jobId: string = (createdJob as { id: string }).id;

    const markJob = async (status: string, error: string | null): Promise<Agent4Result | null> => {
      const { error: err } = await adminClient
        .from('generation_jobs')
        .update({ status, error })
        .eq('id', jobId);
      if (err) return fail('a stock feladat állapotának mentése', err);
      return null;
    };

    // ------------------------------------------------------------------
    // 9. Keresés (gyorsítótárral)
    // ------------------------------------------------------------------
    const apiKey = (process.env.PIXABAY_API_KEY ?? '').trim();
    if (!apiKey) {
      const writeErr = await markJob(
        'failed',
        'A Pixabay API kulcs (PIXABAY_API_KEY) nincs beállítva. A stock videó keresése nem lehetséges.'
      );
      if (writeErr) return writeErr;
      return {
        success: false,
        message:
          'A Pixabay API kulcs (PIXABAY_API_KEY) nincs beállítva. A stock videó keresése nem lehetséges.',
      };
    }

    const keywords = extractKeywords(nextShot.visual_prompt_en ?? '');
    if (!keywords) {
      const writeErr = await markJob(
        'failed',
        'A vizuális promptból nem sikerült keresési kulcsszavakat kinyerni.'
      );
      if (writeErr) return writeErr;
      return {
        success: false,
        message: 'A vizuális promptból nem sikerült keresési kulcsszavakat kinyerni.',
      };
    }

    let search = await searchPixabay(adminClient, apiKey, keywords);

    if (search.rateLimited) {
      const writeErr = await markJob('failed', 'Pixabay korlát elérve, próbáld később.');
      if (writeErr) return writeErr;
      return { success: false, message: 'korlát elérve, próbáld később' };
    }
    if (search.tooManyRequests) {
      const writeErr = await markJob(
        'failed',
        'A Pixabay túl sok kérést kapott (429). Próbáld később.'
      );
      if (writeErr) return writeErr;
      return {
        success: false,
        message: 'A Pixabay túl sok kérést kapott (429). Próbáld később.',
      };
    }
    if (!search.ok) {
      const writeErr = await markJob('failed', `Pixabay keresési hiba: ${search.error ?? 'ismeretlen ok'}`);
      if (writeErr) return writeErr;
      return fail('a Pixabay keresés', search.error);
    }

    let picked = pickClip(search.hits, neededSeconds);

    // Egyetlen szélesebb keresés, ha az első nem adott megfelelőt.
    if (!picked) {
      const broader = broaderKeywords(keywords);
      if (broader && broader !== keywords) {
        search = await searchPixabay(adminClient, apiKey, broader);
        if (search.rateLimited) {
          const writeErr = await markJob('failed', 'Pixabay korlát elérve, próbáld később.');
          if (writeErr) return writeErr;
          return { success: false, message: 'korlát elérve, próbáld később' };
        }
        if (search.tooManyRequests) {
          const writeErr = await markJob(
            'failed',
            'A Pixabay túl sok kérést kapott (429). Próbáld később.'
          );
          if (writeErr) return writeErr;
          return {
            success: false,
            message: 'A Pixabay túl sok kérést kapott (429). Próbáld később.',
          };
        }
        if (!search.ok) {
          const writeErr = await markJob(
            'failed',
            `Pixabay keresési hiba: ${search.error ?? 'ismeretlen ok'}`
          );
          if (writeErr) return writeErr;
          return fail('a Pixabay keresés', search.error);
        }
        picked = pickClip(search.hits, neededSeconds);
      }
    }

    if (!picked) {
      const writeErr = await markJob('failed', NO_CLIP_NOTE);
      if (writeErr) return writeErr;
      const { error: shotErr } = await adminClient
        .from('shots')
        .update({ status: 'needs_review', qc_notes: NO_CLIP_NOTE })
        .eq('id', shotId);
      if (shotErr) return fail('a felvétel állapotának mentése', shotErr);
      return {
        success: false,
        message: NO_CLIP_NOTE,
        data: { shotId, noClip: true },
      };
    }

    // ------------------------------------------------------------------
    // 10. Ugyanaz a Pixabay videó ID nem töltődik le kétszer egy projektben
    // ------------------------------------------------------------------
    const pixabayId = String(picked.hit.id);
    const reusedAsset = assets.find(
      (a) =>
        a.provider === 'pixabay' &&
        typeof a.storage_path === 'string' &&
        a.storage_path.includes(`pixabay-${pixabayId}-`)
    );

    if (reusedAsset) {
      const linked = await linkTimelineItem(
        adminClient,
        projectId,
        shotId,
        reusedAsset.id,
        orderedShots,
        nextShot
      );
      if (!linked.ok) return linked.result;

      const writeErr = await markJob('succeeded', null);
      if (writeErr) return writeErr;

      const shotResult = await applyShotSuccess(adminClient, shotId, hasCharacters);
      if (!shotResult.ok) return shotResult.result;

      return {
        success: true,
        message: `A felvételhez egy már elmentett stock videót használtunk újra (Pixabay azonosító: ${pixabayId}).`,
        data: { shotId, reused: true, pixabayId },
      };
    }

    // ------------------------------------------------------------------
    // 11. Letöltés + ellenőrzés
    // ------------------------------------------------------------------
    const download = await downloadClip(picked.url);
    if (!download.ok) {
      if (download.uncertain) {
        const writeErr = await markJob(
          'uncertain',
          'A letöltés időtúllépett vagy bizonytalan eredményű: a kimenet nem tisztázható.'
        );
        if (writeErr) return writeErr;
        return {
          success: false,
          message:
            'A stock felvétel letöltése bizonytalan eredményű. Újrapróbálás csak a következő manuális lépésben történhet.',
          data: { shotId, uncertain: true },
        };
      }
      const writeErr = await markJob('failed', `A letöltés nem sikerült: ${download.error}`);
      if (writeErr) return writeErr;
      return { success: false, message: `A letöltés nem sikerült: ${download.error}` };
    }

    const validation = validateDownload(download.bytes, {
      contentType: download.contentType,
      contentLength: download.contentLength,
    });
    if (!validation.ok) {
      const writeErr = await markJob('failed', validation.error ?? 'A letöltött fájl érvénytelen.');
      if (writeErr) return writeErr;
      return { success: false, message: validation.error ?? 'A letöltött fájl érvénytelen.' };
    }

    // ------------------------------------------------------------------
    // 12. Feltöltés a "media" bucketbe
    // ------------------------------------------------------------------
    const storagePath = `${projectId}/${shotId}/pixabay-${pixabayId}-${picked.renditionKey}.mp4`;
    const buffer = download.bytes.slice().buffer;
    const blob = new Blob([buffer], { type: 'video/mp4' });

    const { error: uploadErr } = await adminClient.storage
      .from(MEDIA_BUCKET)
      .upload(storagePath, blob, { contentType: 'video/mp4', upsert: false });

    if (uploadErr) {
      const writeErr = await markJob('failed', `A feltöltés nem sikerült: ${uploadErr.message}`);
      if (writeErr) return writeErr;
      return fail('a fájl feltöltése a Storage-be', uploadErr);
    }

    // ------------------------------------------------------------------
    // 13. media_assets sor (a Pixabay URL-je NEM kerül public_url-ba)
    // ------------------------------------------------------------------
    const attribution = buildAttribution(picked.hit);
    const { data: createdAsset, error: assetInsertErr } = await adminClient
      .from('media_assets')
      .insert({
        project_id: projectId,
        shot_id: shotId,
        type: 'video',
        storage_path: storagePath,
        public_url: null,
        duration_sec: num(picked.duration),
        provider: 'pixabay',
        attribution,
        lipsync_applied: false,
        source_label: 'stock_library',
      })
      .select('id')
      .single();

    if (assetInsertErr) {
      const writeErr = await markJob(
        'failed',
        `A médiafájl nyilvántartásba vétele nem sikerült: ${assetInsertErr.message}`
      );
      if (writeErr) return writeErr;
      return fail('a médiafájl nyilvántartásba vétele', assetInsertErr);
    }

    const assetId: string = (createdAsset as { id: string }).id;

    // ------------------------------------------------------------------
    // 14. A videó idővonal-elem linkelése
    // ------------------------------------------------------------------
    const linked = await linkTimelineItem(
      adminClient,
      projectId,
      shotId,
      assetId,
      orderedShots,
      nextShot
    );
    if (!linked.ok) return linked.result;

    // ------------------------------------------------------------------
    // 15. A feladat sikeres — csak a mentés után
    // ------------------------------------------------------------------
    const writeErr = await markJob('succeeded', null);
    if (writeErr) return writeErr;

    const shotResult = await applyShotSuccess(adminClient, shotId, hasCharacters);
    if (!shotResult.ok) return shotResult.result;

    return {
      success: true,
      message: `Stock felvétel elmentve (Pixabay azonosító: ${pixabayId}).`,
      data: {
        shotId,
        pixabayId,
        storagePath,
        durationSec: num(picked.duration),
        label: AGENT4_LABEL,
      },
    };
  } catch (err: unknown) {
    return fail('a stock felvétel feldolgozása', err);
  }
}

/** A linkeléshez szükséges minimális felvételadat. */
export interface LinkableShot {
  id: string;
  actual_duration_sec: number | null;
  target_duration_sec: number | null;
}

/** Linkeli a videó idővonal-elemet a médiafájlhoz (vagy létrehozza). */
export async function linkTimelineItem(
  adminClient: SupabaseClient,
  projectId: string,
  shotId: string,
  mediaAssetId: string,
  orderedShots: LinkableShot[],
  shot: LinkableShot
): Promise<{ ok: true } | { ok: false; result: Agent4Result }> {
  const position = orderedShots.findIndex((s) => s.id === shotId) + 1;

  let startSeconds = 0;
  for (const s of orderedShots) {
    if (s.id === shotId) break;
    startSeconds += num(s.actual_duration_sec) || num(s.target_duration_sec);
  }

  const duration = num(shot.actual_duration_sec) || num(shot.target_duration_sec);

  const { data: existing, error: existingErr } = await adminClient
    .from('timeline_items')
    .select('id')
    .eq('project_id', projectId)
    .eq('track', 'video')
    .eq('shot_id', shotId)
    .maybeSingle();

  if (existingErr) {
    return { ok: false, result: fail('a videó idővonal-elem keresése', existingErr) };
  }

  if (existing) {
    // Újrafeldolgozáskor a kezdőidőt és a hosszt is újra kell számolni:
    // ha egy korábbi felvétel hossza megváltozott, az összes utána következő
    // elem elcsúszik az idővonalon.
    const { error } = await adminClient
      .from('timeline_items')
      .update({
        media_asset_id: mediaAssetId,
        start_seconds: startSeconds,
        source_in: 0,
        source_out: duration,
        duration_seconds: duration,
        sequence_order: position,
      })
      .eq('id', (existing as { id: string }).id);
    if (error) {
      return { ok: false, result: fail('a videó idővonal-elem frissítése', error) };
    }
    return { ok: true };
  }

  const { error } = await adminClient.from('timeline_items').insert({
    project_id: projectId,
    track: 'video',
    shot_id: shotId,
    media_asset_id: mediaAssetId,
    start_seconds: startSeconds,
    source_in: 0,
    source_out: duration,
    duration_seconds: duration,
    sequence_order: position,
  });

  if (error && !isUniqueViolation(error)) {
    return { ok: false, result: fail('a videó idővonal-elem létrehozása', error) };
  }
  return { ok: true };
}

/** Siker után a felvétel állapota. */
async function applyShotSuccess(
  adminClient: SupabaseClient,
  shotId: string,
  hasCharacters: boolean
): Promise<{ ok: true } | { ok: false; result: Agent4Result }> {
  if (hasCharacters) {
    const { error } = await adminClient
      .from('shots')
      .update({
        status: 'needs_review',
        qc_notes: PLACEHOLDER_NOTE,
        qc_technical: 'pending',
      })
      .eq('id', shotId);
    if (error) {
      return { ok: false, result: fail('a felvétel állapotának mentése', error) };
    }
    return { ok: true };
  }

  const { error } = await adminClient
    .from('shots')
    .update({ status: 'clip_ready', qc_technical: 'pending' })
    .eq('id', shotId);
  if (error) {
    return { ok: false, result: fail('a felvétel állapotának mentése', error) };
  }
  return { ok: true };
}
