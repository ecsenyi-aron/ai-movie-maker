/**
 * Agent 4 — Prémium munkafolyamat (referencia kép → videó).
 *
 * Egy hívás PONTOSAN EGY rövid lépést végez, a `agent4-premium-plan.ts`
 * döntési szabályai szerint. A modul szerveroldali: a provider kulcs és a
 * service role kliens nem kerülhet a böngészőbe.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { sortShots } from './agent3-helpers.ts';
import {
  composeCharacterReferencePrompt,
  composeLocationReferencePrompt,
  composeVideoPrompt,
  planShotReferences,
} from './agent4-composer.ts';
import {
  FAL_ENDPOINTS,
  FAL_REFERENCE_IMAGE_MEGAPIXELS,
  MOCK_LABEL,
  MOCK_SIMULATED_COST_USD,
  PREMIUM_LABEL,
  getPremiumConfigStatus,
  isStepConfigured,
  type PremiumStep,
} from './agent4-premium-config.ts';
import {
  buildFailureNote,
  computeVideoDuration,
  isStepAttemptAllowed,
  selectNextPhase,
} from './agent4-premium-plan.ts';
import {
  FalProvider,
  MockProvider,
  type PremiumProvider,
  type ProviderVideoElement,
} from './agent4-provider.ts';
import { MEDIA_BUCKET, linkTimelineItem, type Agent4Result } from './agent4.ts';
import { validateDownload } from './agent4-stock.ts';

const DOWNLOAD_TIMEOUT_MS = 120_000;

interface PremiumJobRow {
  id: string;
  shot_id: string | null;
  step: string;
  provider: string;
  attempt: number;
  provider_job_id: string | null;
  status: string;
  error: string | null;
  reference_owner_type: 'character' | 'location' | null;
  reference_owner_id: string | null;
  reserved_cost_usd: number;
}

interface ReferenceOwner {
  type: 'character' | 'location';
  id: string;
  name: string;
  canonical_description: string;
  environmental_attributes?: string | null;
}

interface PremiumShotRow {
  id: string;
  scene_id: string;
  number: number;
  visual_prompt_en: string;
  camera_movement: string | null;
  target_duration_sec: number | null;
  actual_duration_sec: number | null;
  status: string;
  qc_notes: string | null;
  speaker_character_id: string | null;
  featured_character_ids: string[];
}

type PremiumOrderedShot = PremiumShotRow & { position: number };

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

function createProvider(): PremiumProvider {
  const falKey = (process.env.FAL_KEY ?? process.env.FAL_API_KEY ?? '').trim();
  if (getPremiumConfigStatus(falKey) === 'real') {
    return new FalProvider({ apiKey: falKey });
  }
  return new MockProvider();
}

function estimatedCost(step: PremiumStep, durationSec?: number): number | null {
  if (step === 'reference_image') {
    const price = FAL_ENDPOINTS.reference_image.unitPriceUsd;
    if (price === null) return null;
    return Math.round(price * FAL_REFERENCE_IMAGE_MEGAPIXELS * 10_000) / 10_000;
  }
  if (step === 'video') {
    const price = FAL_ENDPOINTS.video.unitPriceUsd;
    if (price === null) return null;
    const seconds = num(durationSec);
    if (seconds <= 0) return null;
    return Math.round(price * seconds * 10_000) / 10_000;
  }
  return null;
}

/**
 * A valódi provider csak ellenőrzött árral futhat.
 * Ha az ár ismeretlen, a lépés tiltva marad (a MOCK provider továbbra is futhat).
 */
function realProviderBlockedReason(
  provider: PremiumProvider,
  step: PremiumStep
): string | null {
  if (provider.simulated) return null;
  if (isStepConfigured(step)) return null;
  return `A(z) ${step} lépés ára nincs ellenőrizve (ismeretlen), ezért a valódi provider le van tiltva.`;
}

async function downloadOutput(url: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      bytes,
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function markJob(
  adminClient: SupabaseClient,
  jobId: string,
  status: string,
  error: string | null
): Promise<Agent4Result | null> {
  const { error: writeError } = await adminClient
    .from('generation_jobs')
    .update({ status, error })
    .eq('id', jobId);
  return writeError ? fail('a prémium feladat állapotának mentése', writeError) : null;
}

/**
 * A költségvetési műveletek (a `budget.ts` alapján).
 *
 * A prémium folyamat ezt injektálható paraméterként kapja, így a
 * költségvetési ellenőrzés automatikus tesztekkel is ellenőrizhető
 * valódi adatbázis és fizetős hívás nélkül.
 */
export interface PremiumBudgetApi {
  /** A keret atomikus foglalása a `reserve_budget` adatbázis-függvénnyel. */
  reserve(
    projectId: string,
    jobId: string,
    amountUsd: number
  ): Promise<{ ok: boolean; reason: string; remaining: number }>;
  /** A foglalás lezárása és a tényleges költség rögzítése. */
  settle(jobId: string, actualUsd: number): Promise<string>;
  /** A foglalás visszaadása (sikertelen lépés esetén). */
  release(jobId: string): Promise<void>;
}

/**
 * A valódi költségvetési műveletek betöltése.
 *
 * A dinamikus import miatt a `budget.ts` (a `server-only` jelöléssel) csak
 * akkor töltődik be, ha ténylegesen költséges művelet kell. A MOCK
 * providerrel (szimulált, 0 USD) futó folyamat és a tesztek nem érintik.
 */
async function loadBudgetApi(): Promise<PremiumBudgetApi> {
  const mod = await import('../budget.ts');
  return {
    reserve: mod.reserveBudget,
    settle: mod.settleBudget,
    release: mod.releaseBudget,
  };
}

async function reserveJobBudget(
  budget: PremiumBudgetApi | undefined,
  projectId: string,
  jobId: string,
  amountUsd: number
): Promise<Agent4Result | null> {
  if (amountUsd <= 0) return null;
  const api = budget ?? (await loadBudgetApi());
  const reservation = await api.reserve(projectId, jobId, amountUsd);
  if (!reservation.ok) {
    return {
      success: false,
      message: `A költségvetési foglalás nem sikerült: ${reservation.reason}.`,
      data: { budgetBlocked: true },
    };
  }
  return null;
}

async function settleOrRelease(
  budget: PremiumBudgetApi | undefined,
  jobId: string,
  amountUsd: number,
  succeeded: boolean
): Promise<void> {
  if (amountUsd <= 0) return;
  const api = budget ?? (await loadBudgetApi());
  if (succeeded) await api.settle(jobId, amountUsd);
  else await api.release(jobId);
}

/**
 * A prémium Agent 4 egyetlen lépése.
 */
export async function advancePremium(
  userClient: SupabaseClient,
  adminClient: SupabaseClient,
  projectId: string,
  options: {
    manualRetry?: boolean;
    forceShotId?: string;
    /** Injektált költségvetési műveletek (teszt és MOCK futtatás). */
    budget?: PremiumBudgetApi;
    /** Injektált provider (teszt). */
    provider?: PremiumProvider;
  } = {}
): Promise<Agent4Result> {
  try {
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData?.user) {
      return { success: false, message: 'Nincs érvényes bejelentkezés.' };
    }

    const { data: ownedProject, error: ownedError } = await userClient
      .from('projects')
      .select('id, user_id')
      .eq('id', projectId)
      .eq('user_id', userData.user.id)
      .maybeSingle();
    if (ownedError) return fail('a projekt tulajdonjogának ellenőrzése', ownedError);
    if (!ownedProject) return { success: false, message: 'Nincs jogosultságod ehhez a projekthez.' };

    const { data: project, error: projectError } = await adminClient
      .from('projects')
      .select('id, approved_at, mode, status, lipsync')
      .eq('id', projectId)
      .maybeSingle();
    if (projectError) return fail('a projekt betöltése', projectError);
    if (!project) return { success: false, message: 'A megadott projekt nem található.' };
    if (!project.approved_at) {
      return { success: false, message: 'A projekt még nincs jóváhagyva.' };
    }
    if (project.mode !== 'premium') {
      return { success: false, message: 'Ez a projekt nem Prémium módban van.' };
    }

    const { data: sceneRows, error: sceneError } = await adminClient
      .from('scenes')
      .select('id, number, location_id')
      .eq('project_id', projectId);
    if (sceneError) return fail('a jelenetek betöltése', sceneError);

    const scenes = (sceneRows ?? []) as Array<{
      id: string;
      number: number;
      location_id: string | null;
    }>;
    const sceneIds = scenes.map((scene) => scene.id);

    let shotRows: PremiumShotRow[] = [];
    if (sceneIds.length > 0) {
      const { data, error } = await adminClient
        .from('shots')
        .select(
          'id, scene_id, number, visual_prompt_en, camera_movement, target_duration_sec, actual_duration_sec, status, qc_notes, speaker_character_id, featured_character_ids'
        )
        .in('scene_id', sceneIds);
      if (error) return fail('a felvételek betöltése', error);
      shotRows = (data ?? []) as PremiumShotRow[];
    }
    const orderedShots = sortShots(scenes, shotRows) as PremiumOrderedShot[];

    const { data: jobRows, error: jobError } = await adminClient
      .from('generation_jobs')
      .select(
        'id, shot_id, step, provider, attempt, provider_job_id, status, error, reference_owner_type, reference_owner_id, reserved_cost_usd'
      )
      .eq('project_id', projectId)
      .in('step', ['reference_image', 'video', 'lipsync']);
    if (jobError) return fail('a prémium feladatok betöltése', jobError);
    const jobs = (jobRows ?? []) as PremiumJobRow[];

    const { data: characterRows, error: characterError } = await adminClient
      .from('characters')
      .select('id, name, canonical_description')
      .eq('project_id', projectId);
    if (characterError) return fail('a szereplők betöltése', characterError);

    const { data: locationRows, error: locationError } = await adminClient
      .from('locations')
      .select('id, name, canonical_description, continuity')
      .eq('project_id', projectId);
    if (locationError) return fail('a helyszínek betöltése', locationError);

    const { data: referenceRows, error: referenceError } = await adminClient
      .from('reference_versions')
      .select('id, owner_type, owner_id, version, storage_path, status')
      .eq('project_id', projectId)
      .eq('status', 'approved');
    if (referenceError) return fail('a referenciák betöltése', referenceError);

    const references = (referenceRows ?? []) as Array<{
      id: string;
      owner_type: 'character' | 'location';
      owner_id: string;
      version: number;
      storage_path: string | null;
      status: string;
    }>;

    const owners: ReferenceOwner[] = [
      ...((characterRows ?? []) as Array<{ id: string; name: string; canonical_description: string }>).map(
        (character) => ({ ...character, type: 'character' as const })
      ),
      ...((locationRows ?? []) as Array<{
        id: string;
        name: string;
        canonical_description: string;
        continuity: Record<string, unknown>;
      }>).map((location) => ({
        type: 'location' as const,
        id: location.id,
        name: location.name,
        canonical_description: location.canonical_description,
        environmental_attributes:
          typeof location.continuity?.environmental_attributes === 'string'
            ? location.continuity.environmental_attributes
            : null,
      })),
    ];

    const missingOwners = owners.filter(
      (owner) =>
        !references.some(
          (reference) =>
            reference.owner_type === owner.type &&
            reference.owner_id === owner.id &&
            Boolean(reference.storage_path)
        )
    );

    // Bizonytalan kimenetek egyeztetése: új fizetős kérés soha nem indul
    // automatikusan. Ha van provider_job_id, csak lekérdezzük (poll);
    // ha nincs, a feladat lezáródik sikertelenként és a foglalás visszajár.
    const uncertainJobs = jobs.filter((job) => job.status === 'uncertain');
    for (const job of uncertainJobs) {
      if (job.provider_job_id) continue; // ez pollolható
      await markJob(
        adminClient,
        job.id,
        'failed',
        'A bizonytalan kimenet után nem maradt provider feladatazonosító: új fizetős kérés nem indult.'
      );
      await settleOrRelease(options.budget, job.id, num(job.reserved_cost_usd), false);
    }

    const pendingReferenceJobs = jobs.filter(
      (job) =>
        job.step === 'reference_image' &&
        (['pending', 'submitted', 'processing'].includes(job.status) ||
          (job.status === 'uncertain' && Boolean(job.provider_job_id)))
    );
    const pendingVideoJobs = jobs.filter(
      (job) =>
        job.step === 'video' &&
        job.shot_id &&
        (['pending', 'submitted', 'processing'].includes(job.status) ||
          (job.status === 'uncertain' && Boolean(job.provider_job_id)))
    );
    const succeededVideoShotIds = new Set(
      jobs
        .filter((job) => job.step === 'video' && job.status === 'succeeded' && job.shot_id)
        .map((job) => job.shot_id as string)
    );
    const forcedShotId = options.forceShotId ?? null;
    const pendingVideoShots = orderedShots.filter(
      (shot) =>
        !succeededVideoShotIds.has(shot.id) &&
        shot.status !== 'clip_ready' &&
        shot.status !== 'qc_ok' &&
        (forcedShotId === null || shot.id === forcedShotId)
    );

    const phase = selectNextPhase({
      hasPendingReferenceJobs: pendingReferenceJobs.length > 0,
      missingReferenceCount: missingOwners.length,
      pendingVideoShotCount: pendingVideoShots.length,
    });

    if (phase.phase === 'done') {
      return { success: true, message: 'nincs több teendő', data: { phase: 'done' } };
    }

    const provider = options.provider ?? createProvider();
    const providerId = provider.id;

    if (phase.phase === 'reference') {
      const pendingJob = pendingReferenceJobs[0];
      if (pendingJob) {
        return pollReferenceJob(
          adminClient,
          provider,
          projectId,
          pendingJob,
          owners,
          references,
          options.budget
        );
      }
      const owner = missingOwners[0];
      if (!owner) return { success: true, message: 'nincs több teendő' };

      const existingAttempts = jobs.filter(
        (job) =>
          job.step === 'reference_image' &&
          job.reference_owner_type === owner.type &&
          job.reference_owner_id === owner.id
      ).length;
      const attemptDecision = isStepAttemptAllowed({
        existingAttempts,
        manualRetry: options.manualRetry === true,
      });
      if (!attemptDecision.allowed) {
        return { success: false, message: attemptDecision.reason };
      }

      const prompt =
        owner.type === 'character'
          ? composeCharacterReferencePrompt({
              name: owner.name,
              canonicalDescription: owner.canonical_description,
            })
          : composeLocationReferencePrompt({
              name: owner.name,
              canonicalDescription: owner.canonical_description,
              environmentalAttributes: owner.environmental_attributes ?? null,
            });

      const blockedReason = realProviderBlockedReason(provider, 'reference_image');
      if (blockedReason) {
        return { success: false, message: blockedReason, data: { phase: 'reference' } };
      }
      const cost = provider.simulated
        ? MOCK_SIMULATED_COST_USD
        : (estimatedCost('reference_image') ?? 0);
      const { data: createdJob, error: insertError } = await adminClient
        .from('generation_jobs')
        .insert({
          project_id: projectId,
          shot_id: null,
          provider: providerId,
          step: 'reference_image',
          attempt: existingAttempts + 1,
          prompt,
          status: 'pending',
          estimated_cost_usd: cost,
          reserved_cost_usd: cost,
          actual_cost_usd: 0,
          error: null,
          reference_owner_type: owner.type,
          reference_owner_id: owner.id,
        })
        .select('id')
        .single();
      if (insertError) return fail('a prémium referencia feladat létrehozása', insertError);
      const jobId = (createdJob as { id: string }).id;

      const budgetError = await reserveJobBudget(options.budget, projectId, jobId, cost);
      if (budgetError) {
        await markJob(adminClient, jobId, 'failed', budgetError.message);
        return budgetError;
      }

      const submitted = await provider.submitReferenceImage({ prompt });
      if (!submitted.ok || !submitted.providerJobId) {
        if (submitted.uncertain) {
          // Bizonytalan kimenet: NEM indítunk új fizetős kérést.
          // A foglalás bent marad, a feladat `uncertain` marad a manuális
          // egyeztetésig (a következő advance() elején tisztázódik).
          // Ha van provider feladatazonosító, elmentjük, hogy a következő
          // advance() csak lekérdezhesse (poll) a kimenetet.
          if (submitted.providerJobId) {
            await adminClient
              .from('generation_jobs')
              .update({ provider_job_id: submitted.providerJobId })
              .eq('id', jobId);
          }
          await markJob(
            adminClient,
            jobId,
            'uncertain',
            submitted.error ?? 'A referencia kép eredménye bizonytalan.'
          );
          return {
            success: false,
            message:
              submitted.error ??
              'A referencia kép eredménye bizonytalan: új fizetős kérés nem indult.',
            data: { phase: 'reference', ownerId: owner.id, uncertain: true },
          };
        }
        await markJob(adminClient, jobId, 'failed', submitted.error ?? 'ismeretlen hiba');
        await settleOrRelease(options.budget, jobId, cost, false);
        return {
          success: false,
          message: submitted.error ?? 'A referencia kép indítása nem sikerült.',
          data: { phase: 'reference', ownerId: owner.id },
        };
      }

      await adminClient
        .from('generation_jobs')
        .update({ status: 'submitted', provider_job_id: submitted.providerJobId })
        .eq('id', jobId);

      const job: PremiumJobRow = {
        id: jobId,
        shot_id: null,
        step: 'reference_image',
        provider: providerId,
        attempt: existingAttempts + 1,
        provider_job_id: submitted.providerJobId,
        status: 'submitted',
        error: null,
        reference_owner_type: owner.type,
        reference_owner_id: owner.id,
        reserved_cost_usd: cost,
      };
      return pollReferenceJob(
        adminClient,
        provider,
        projectId,
        job,
        owners,
        references,
        options.budget
      );
    }

    // Videó fázis: a folyamatban lévő feladatot előbb le kell kérdezni.
    const pendingVideoJob = pendingVideoJobs[0];
    if (pendingVideoJob) {
      const pendingShot = shotRows.find((candidate) => candidate.id === pendingVideoJob.shot_id);
      if (!pendingShot) {
        await markJob(adminClient, pendingVideoJob.id, 'failed', 'A felvétel nem található.');
        return { success: false, message: 'A felvétel nem található.' };
      }
      return pollVideoJob(
        adminClient,
        provider,
        projectId,
        pendingVideoJob,
        pendingShot,
        orderedShots,
        options.budget
      );
    }

    const shot = pendingVideoShots[0];
    if (!shot) return { success: true, message: 'nincs több teendő' };

    const characters = ((characterRows ?? []) as Array<{
      id: string;
      name: string;
      canonical_description: string;
    }>).map((character) => ({
      id: character.id,
      name: character.name,
      canonicalDescription: character.canonical_description,
    }));
    const scene = scenes.find((candidate) => candidate.id === shot.scene_id);
    const location = owners.find(
      (owner) => owner.type === 'location' && owner.id === scene?.location_id
    );
    // Multi-reference terv: az első referencia a `start_image_url`, a többi
    // (további főszereplők, helyszín) az `elements` tömbbe kerül.
    const plan = planShotReferences({
      featuredCharacterIds: shot.featured_character_ids,
      speakerCharacterId: shot.speaker_character_id,
      characters,
      location: location
        ? {
            id: location.id,
            name: location.name,
            canonicalDescription: location.canonical_description,
            environmentalAttributes: location.environmental_attributes ?? null,
          }
        : null,
    });
    if (!plan.primary) {
      return {
        success: false,
        message: plan.reason ?? 'A felvételhez nincs használható referencia.',
        data: { shotId: shot.id },
      };
    }

    const findReference = (ownerType: 'character' | 'location', ownerId: string) =>
      references.find(
        (candidate) =>
          candidate.owner_type === ownerType &&
          candidate.owner_id === ownerId &&
          Boolean(candidate.storage_path)
      );

    const primaryReference = findReference(plan.primary.kind, plan.primary.id);
    if (!primaryReference?.storage_path) {
      return {
        success: false,
        message: 'A felvételhez szükséges referencia kép még nem készült el.',
        data: { shotId: shot.id, phase: 'reference' },
      };
    }

    const { data: signedData, error: signedError } = await adminClient.storage
      .from(MEDIA_BUCKET)
      .createSignedUrl(primaryReference.storage_path, 3600);
    if (signedError || !signedData?.signedUrl) {
      return fail('a referencia kép ideiglenes URL-jének létrehozása', signedError);
    }

    // A további referenciák ideiglenes URL-jei az `elements` tömbbe kerülnek.
    // A promptban @Element1, @Element2 formában hivatkozunk rájuk.
    const elements: ProviderVideoElement[] = [];
    const elementReferences: string[] = [];
    for (const extra of plan.additional) {
      const extraReference = findReference(extra.kind, extra.id);
      if (!extraReference?.storage_path) continue;
      const { data: extraSigned, error: extraError } = await adminClient.storage
        .from(MEDIA_BUCKET)
        .createSignedUrl(extraReference.storage_path, 3600);
      if (extraError || !extraSigned?.signedUrl) continue;
      elements.push({ frontalImageUrl: extraSigned.signedUrl });
      elementReferences.push(`@Element${elements.length}`);
    }

    // Az `actual_duration_sec` az Agent 3 által rögzített hanghossz:
    // a videó nem lehet rövidebb a hangnál.
    const audioSec = num(shot.actual_duration_sec) || null;
    const desiredSec = audioSec ?? num(shot.target_duration_sec);
    const duration = computeVideoDuration({
      desiredSec,
      audioSec,
      supported: FAL_ENDPOINTS.video.supportedDurationsSec,
    });
    if (duration.durationSec === null) {
      await adminClient
        .from('shots')
        .update({ status: 'needs_review', qc_notes: duration.reason })
        .eq('id', shot.id);
      return { success: false, message: duration.reason, data: { shotId: shot.id } };
    }

    const existingAttempts = jobs.filter(
      (job) => job.step === 'video' && job.shot_id === shot.id
    ).length;
    const attemptDecision = isStepAttemptAllowed({
      existingAttempts,
      manualRetry: options.manualRetry === true,
    });
    if (!attemptDecision.allowed) {
      return { success: false, message: attemptDecision.reason, data: { shotId: shot.id } };
    }

    const prompt = composeVideoPrompt({
      visualPromptEn: shot.visual_prompt_en,
      cameraMovement: shot.camera_movement,
      elementReferences,
    });
    const blockedReason = realProviderBlockedReason(provider, 'video');
    if (blockedReason) {
      return { success: false, message: blockedReason, data: { shotId: shot.id, phase: 'video' } };
    }
    const cost = provider.simulated
      ? MOCK_SIMULATED_COST_USD
      : (estimatedCost('video', duration.durationSec) ?? 0);

    const { data: createdJob, error: insertError } = await adminClient
      .from('generation_jobs')
      .insert({
        project_id: projectId,
        shot_id: shot.id,
        provider: providerId,
        step: 'video',
        attempt: existingAttempts + 1,
        prompt,
        status: 'pending',
        estimated_cost_usd: cost,
        reserved_cost_usd: cost,
        actual_cost_usd: 0,
        error: null,
      })
      .select('id')
      .single();
    if (insertError) return fail('a prémium videó feladat létrehozása', insertError);
    const jobId = (createdJob as { id: string }).id;

    const budgetError = await reserveJobBudget(options.budget, projectId, jobId, cost);
    if (budgetError) {
      await markJob(adminClient, jobId, 'failed', budgetError.message);
      return budgetError;
    }

    const submitted = await provider.submitVideo({
      prompt,
      imageUrl: signedData.signedUrl,
      durationSec: duration.durationSec,
      elements,
    });
    if (!submitted.ok || !submitted.providerJobId) {
      if (submitted.uncertain) {
        // Bizonytalan kimenet: NEM indítunk új fizetős kérést.
        // Ha van provider feladatazonosító, elmentjük, hogy a következő
        // advance() csak lekérdezhesse (poll) a kimenetet.
        if (submitted.providerJobId) {
          await adminClient
            .from('generation_jobs')
            .update({ provider_job_id: submitted.providerJobId })
            .eq('id', jobId);
        }
        await markJob(
          adminClient,
          jobId,
          'uncertain',
          submitted.error ?? 'A videó eredménye bizonytalan.'
        );
        return {
          success: false,
          message:
            submitted.error ??
            'A videó eredménye bizonytalan: új fizetős kérés nem indult.',
          data: { shotId: shot.id, phase: 'video', uncertain: true },
        };
      }
      await markJob(adminClient, jobId, 'failed', submitted.error ?? 'ismeretlen hiba');
      await settleOrRelease(options.budget, jobId, cost, false);
      return {
        success: false,
        message: submitted.error ?? 'A videó indítása nem sikerült.',
        data: { shotId: shot.id, phase: 'video' },
      };
    }

    await adminClient
      .from('generation_jobs')
      .update({ status: 'submitted', provider_job_id: submitted.providerJobId })
      .eq('id', jobId);

    const job: PremiumJobRow = {
      id: jobId,
      shot_id: shot.id,
      step: 'video',
      provider: providerId,
      attempt: existingAttempts + 1,
      provider_job_id: submitted.providerJobId,
      status: 'submitted',
      error: null,
      reference_owner_type: null,
      reference_owner_id: null,
      reserved_cost_usd: cost,
    };
    return pollVideoJob(
      adminClient,
      provider,
      projectId,
      job,
      shot,
      orderedShots,
      options.budget
    );
  } catch (error: unknown) {
    return fail('a prémium felvétel feldolgozása', error);
  }
}

async function pollReferenceJob(
  adminClient: SupabaseClient,
  provider: PremiumProvider,
  projectId: string,
  job: PremiumJobRow,
  owners: ReferenceOwner[],
  references: Array<{
    id: string;
    owner_type: 'character' | 'location';
    owner_id: string;
    version: number;
    storage_path: string | null;
    status: string;
  }>,
  budget?: PremiumBudgetApi
): Promise<Agent4Result> {
  if (!job.provider_job_id) {
    await markJob(adminClient, job.id, 'failed', 'A provider feladatazonosító hiányzik.');
    return { success: false, message: 'A provider feladatazonosító hiányzik.' };
  }

  const polled = await provider.poll('reference_image', job.provider_job_id);
  if (polled.status === 'pending' || polled.status === 'processing') {
    await markJob(adminClient, job.id, 'processing', polled.error ?? null);
    return { success: false, message: 'folyamatban', data: { phase: 'reference' } };
  }
  if (polled.status === 'failed') {
    const error = polled.error ?? 'ismeretlen hiba';
    await markJob(adminClient, job.id, 'failed', error);
    await settleOrRelease(budget, job.id, num(job.reserved_cost_usd), false);
    return { success: false, message: buildFailureNote('reference_image', error) };
  }

  const owner = owners.find(
    (candidate) =>
      candidate.type === job.reference_owner_type && candidate.id === job.reference_owner_id
  );
  if (!owner) {
    await markJob(adminClient, job.id, 'failed', 'A referencia tulajdonosa nem található.');
    return { success: false, message: 'A referencia tulajdonosa nem található.' };
  }

  let bytes = polled.outputBytes;
  let contentType = polled.outputContentType ?? 'image/png';
  if (!bytes && polled.outputUrl) {
    const downloaded = await downloadOutput(polled.outputUrl);
    bytes = downloaded.bytes;
    contentType = downloaded.contentType;
  }
  if (!bytes) {
    await markJob(adminClient, job.id, 'failed', 'A provider nem adott vissza referenciaképet.');
    return { success: false, message: 'A provider nem adott vissza referenciaképet.' };
  }

  const storagePath = `${projectId}/references/${owner.type}-${owner.id}-${job.id}.png`;
  const { error: uploadError } = await adminClient.storage
    .from(MEDIA_BUCKET)
    .upload(storagePath, new Blob([bytes.slice().buffer], { type: contentType }), {
      contentType,
      upsert: false,
    });
  if (uploadError) {
    await markJob(adminClient, job.id, 'failed', `A feltöltés nem sikerült: ${uploadError.message}`);
    return fail('a referencia kép feltöltése', uploadError);
  }

  const version =
    Math.max(
      0,
      ...references
        .filter(
          (reference) =>
            reference.owner_type === owner.type && reference.owner_id === owner.id
        )
        .map((reference) => num(reference.version))
    ) + 1;

  const { error: referenceInsertError } = await adminClient.from('reference_versions').insert({
    project_id: projectId,
    owner_type: owner.type,
    owner_id: owner.id,
    version,
    storage_path: storagePath,
    prompt: null,
    status: 'approved',
    gate_status: 'passed',
    gate_issues: [],
    gate_checked_at: new Date().toISOString(),
  });
  if (referenceInsertError) {
    await markJob(adminClient, job.id, 'failed', `A referencia nyilvántartásba vétele nem sikerült: ${referenceInsertError.message}`);
    return fail('a referencia nyilvántartásba vétele', referenceInsertError);
  }

  await markJob(adminClient, job.id, 'succeeded', null);
  await settleOrRelease(budget, job.id, num(job.reserved_cost_usd), true);
  return {
    success: true,
    message: 'A referencia kép elkészült.',
    data: { phase: 'reference', ownerId: owner.id, storagePath },
  };
}

async function pollVideoJob(
  adminClient: SupabaseClient,
  provider: PremiumProvider,
  projectId: string,
  job: PremiumJobRow,
  shot: PremiumShotRow,
  orderedShots: PremiumOrderedShot[],
  budget?: PremiumBudgetApi
): Promise<Agent4Result> {
  if (!job.provider_job_id) {
    await markJob(adminClient, job.id, 'failed', 'A provider feladatazonosító hiányzik.');
    return { success: false, message: 'A provider feladatazonosító hiányzik.' };
  }

  const polled = await provider.poll('video', job.provider_job_id);
  if (polled.status === 'pending' || polled.status === 'processing') {
    await markJob(adminClient, job.id, 'processing', polled.error ?? null);
    return { success: false, message: 'folyamatban', data: { shotId: shot.id, phase: 'video' } };
  }
  if (polled.status === 'failed') {
    const error = polled.error ?? 'ismeretlen hiba';
    await markJob(adminClient, job.id, 'failed', error);
    await settleOrRelease(budget, job.id, num(job.reserved_cost_usd), false);
    await adminClient
      .from('shots')
      .update({ status: 'needs_review', qc_notes: buildFailureNote('video', error) })
      .eq('id', shot.id);
    return {
      success: false,
      message: buildFailureNote('video', error),
      data: { shotId: shot.id, stockFallbackAvailable: true },
    };
  }

  let bytes = polled.outputBytes;
  let contentType = polled.outputContentType ?? 'video/mp4';
  if (!bytes && polled.outputUrl) {
    const downloaded = await downloadOutput(polled.outputUrl);
    bytes = downloaded.bytes;
    contentType = downloaded.contentType;
  }
  if (!bytes) {
    await markJob(adminClient, job.id, 'failed', 'A provider nem adott vissza videót.');
    return { success: false, message: 'A provider nem adott vissza videót.' };
  }

  // A videó csak ellenőrzés után tekinthető "ready"-nek.
  const validation = validateDownload(bytes, { contentType });
  if (!validation.ok) {
    const error = validation.error ?? 'A letöltött videó nem ellenőrizhető.';
    await markJob(adminClient, job.id, 'failed', error);
    await settleOrRelease(budget, job.id, num(job.reserved_cost_usd), false);
    await adminClient
      .from('shots')
      .update({ status: 'needs_review', qc_notes: buildFailureNote('video', error) })
      .eq('id', shot.id);
    return {
      success: false,
      message: buildFailureNote('video', error),
      data: { shotId: shot.id, stockFallbackAvailable: true },
    };
  }

  const storagePath = `${projectId}/${shot.id}/premium-${job.id}.mp4`;
  const { error: uploadError } = await adminClient.storage
    .from(MEDIA_BUCKET)
    .upload(storagePath, new Blob([bytes.slice().buffer], { type: contentType }), {
      contentType,
      upsert: false,
    });
  if (uploadError) {
    await markJob(adminClient, job.id, 'failed', `A feltöltés nem sikerült: ${uploadError.message}`);
    return fail('a prémium videó feltöltése', uploadError);
  }

  const { data: createdAsset, error: assetError } = await adminClient
    .from('media_assets')
    .insert({
      project_id: projectId,
      shot_id: shot.id,
      type: 'video',
      storage_path: storagePath,
      public_url: null,
      duration_sec: num(shot.actual_duration_sec) || num(shot.target_duration_sec),
      provider: provider.id,
      attribution: provider.simulated ? MOCK_LABEL : PREMIUM_LABEL,
      lipsync_applied: false,
      source_label: provider.sourceLabel,
    })
    .select('id')
    .single();
  if (assetError) {
    await markJob(adminClient, job.id, 'failed', `A médiafájl nyilvántartásba vétele nem sikerült: ${assetError.message}`);
    return fail('a prémium médiafájl nyilvántartásba vétele', assetError);
  }

  const linked = await linkTimelineItem(
    adminClient,
    projectId,
    shot.id,
    (createdAsset as { id: string }).id,
    orderedShots,
    shot
  );
  if (!linked.ok) return linked.result;

  await markJob(adminClient, job.id, 'succeeded', null);
  await settleOrRelease(budget, job.id, num(job.reserved_cost_usd), true);
  await adminClient
    .from('shots')
    .update({ status: 'clip_ready', qc_technical: 'pending' })
    .eq('id', shot.id);

  return {
    success: true,
    message: 'A prémium felvétel elmentve.',
    data: {
      phase: 'video',
      shotId: shot.id,
      storagePath,
      durationSec: num(shot.actual_duration_sec) || num(shot.target_duration_sec),
      label: PREMIUM_LABEL,
    },
  };
}
