/**
 * Agent 4 — Prémium UI segédfüggvények (tiszta, tesztelhető).
 *
 * Ez a modul NEM hálózatot, NEM adatbázist és NEM providert használ:
 * csak a böngészőben megjelenítendő állapotokat számolja ki.
 * Így a UI logika unit tesztekkel is ellenőrizhető.
 */

import { chooseReferenceForShot } from './agent4-composer.ts';
import { estimateStepCostUsd } from './agent4-premium-config.ts';
import { formatCostUsd } from './agent4-premium-plan.ts';

/** A referencia készültségi állapota. */
export type ReferenceStatus = 'ready' | 'missing' | 'pending' | 'failed' | 'uncertain';

/** A videó készültségi állapota. */
export type VideoStatus = 'ready' | 'pending' | 'failed' | 'uncertain' | 'not_started';

/** Egy szereplő vagy helyszín rövid leírása (a UI-hoz). */
export interface UiOwner {
  id: string;
  name: string;
}

/** Egy felvételhez tartozó referencia-tulajdonos. */
export interface ShotReferenceOwner {
  type: 'character' | 'location';
  id: string;
  name: string;
}

/** A felvétel referencia-tulajdonosa és annak készültségi állapota. */
export interface ShotReferenceView {
  owner: ShotReferenceOwner | null;
  status: ReferenceStatus;
  /** Magyar felirat az UI-hoz. */
  label: string;
}

/** A felvétel videójának készültségi állapota. */
export interface ShotVideoView {
  status: VideoStatus;
  /** Magyar felirat az UI-hoz. */
  label: string;
  /** Hibaüzenet (ha van). */
  error: string | null;
}

/** A UI-hoz használt feladat (generation_jobs) sor. */
export interface UiJob {
  id: string;
  shot_id: string | null;
  step: string;
  provider: string;
  attempt: number;
  status: string;
  error: string | null;
  reference_owner_type: 'character' | 'location' | null;
  reference_owner_id: string | null;
  estimated_cost_usd: number;
}

/** A UI-hoz használt referencia (reference_versions) sor. */
export interface UiReference {
  id: string;
  owner_type: 'character' | 'location';
  owner_id: string;
  status: string;
  storage_path: string | null;
}

/**
 * A felvétel referencia-tulajdonosa.
 *
 * Ugyanaz a szabály, mint a videókészítésnél:
 * pontosan egy főszereplő -> az a karakter, egyébként -> a helyszín.
 */
export function resolveShotReferenceOwner(input: {
  featuredCharacterIds?: string[] | null;
  speakerCharacterId?: string | null;
  characters: UiOwner[];
  location: UiOwner | null;
}): ShotReferenceOwner | null {
  const choice = chooseReferenceForShot({
    featuredCharacterIds: input.featuredCharacterIds ?? null,
    speakerCharacterId: input.speakerCharacterId ?? null,
    characters: input.characters.map((c) => ({ id: c.id, name: c.name })),
    location: input.location
      ? { id: input.location.id, name: input.location.name }
      : null,
  });

  if (choice.kind === 'character') {
    return { type: 'character', id: choice.character.id, name: choice.character.name ?? '' };
  }
  if (choice.kind === 'location') {
    return { type: 'location', id: choice.location.id, name: choice.location.name ?? '' };
  }
  return null;
}

/** A referencia készültségi állapotának magyar felirata. */
export function referenceStatusLabel(status: ReferenceStatus): string {
  switch (status) {
    case 'ready':
      return 'kész';
    case 'pending':
      return 'folyamatban';
    case 'failed':
      return 'sikertelen';
    case 'uncertain':
      return 'bizonytalan';
    case 'missing':
    default:
      return 'hiányzik';
  }
}

/** A videó készültségi állapotának magyar felirata. */
export function videoStatusLabel(status: VideoStatus): string {
  switch (status) {
    case 'ready':
      return 'kész';
    case 'pending':
      return 'folyamatban';
    case 'failed':
      return 'sikertelen';
    case 'uncertain':
      return 'bizonytalan';
    case 'not_started':
    default:
      return 'még nem indult';
  }
}

/**
 * A referencia állapota egy adott tulajdonoshoz.
 *
 * A sorrend: kész referencia -> futó feladat -> bizonytalan -> sikertelen -> hiányzik.
 */
export function resolveReferenceStatus(input: {
  ownerType: 'character' | 'location';
  ownerId: string;
  references: UiReference[];
  jobs: UiJob[];
}): ReferenceStatus {
  const hasApproved = input.references.some(
    (reference) =>
      reference.owner_type === input.ownerType &&
      reference.owner_id === input.ownerId &&
      reference.status === 'approved' &&
      Boolean(reference.storage_path)
  );
  if (hasApproved) return 'ready';

  const ownerJobs = input.jobs.filter(
    (job) =>
      job.step === 'reference_image' &&
      job.reference_owner_type === input.ownerType &&
      job.reference_owner_id === input.ownerId
  );

  if (ownerJobs.some((job) => ['pending', 'submitted', 'processing'].includes(job.status))) {
    return 'pending';
  }
  if (ownerJobs.some((job) => job.status === 'uncertain')) return 'uncertain';
  if (ownerJobs.some((job) => job.status === 'failed')) return 'failed';
  return 'missing';
}

/**
 * A felvétel videójának állapota.
 *
 * A kész videó a `media_assets` sor (vagy a sikeres feladat) alapján állapítható meg.
 */
export function resolveVideoStatus(input: {
  shotId: string;
  jobs: UiJob[];
  hasAsset: boolean;
}): ShotVideoView {
  const shotJobs = input.jobs.filter(
    (job) => job.step === 'video' && job.shot_id === input.shotId
  );

  if (input.hasAsset || shotJobs.some((job) => job.status === 'succeeded')) {
    return { status: 'ready', label: videoStatusLabel('ready'), error: null };
  }
  if (shotJobs.some((job) => ['pending', 'submitted', 'processing'].includes(job.status))) {
    return { status: 'pending', label: videoStatusLabel('pending'), error: null };
  }
  if (shotJobs.some((job) => job.status === 'uncertain')) {
    return {
      status: 'uncertain',
      label: videoStatusLabel('uncertain'),
      error: 'A videó eredménye bizonytalan: új fizetős kérés nem indult.',
    };
  }
  const failed = shotJobs.find((job) => job.status === 'failed');
  if (failed) {
    return {
      status: 'failed',
      label: videoStatusLabel('failed'),
      error: failed.error ?? 'A videó készítése nem sikerült.',
    };
  }
  return { status: 'not_started', label: videoStatusLabel('not_started'), error: null };
}

/**
 * A felvétel becsült videóköltsége.
 * `null` = ismeretlen ár (a UI "ismeretlen"-t mutat).
 */
export function estimateShotVideoCostUsd(durationSec: number | null | undefined): number | null {
  const seconds = Number(durationSec ?? 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return estimateStepCostUsd('video', { durationSec: seconds });
}

/** A teljes prémium folyamat (referenciák + videók) becsült költsége. */
export function estimateProjectCostUsd(input: {
  missingReferenceCount: number;
  shots: Array<{ durationSec: number | null | undefined }>;
}): number | null {
  const referenceCost = estimateStepCostUsd('reference_image', {
    megapixels: (1280 * 720) / 1_000_000,
  });
  if (referenceCost === null) return null;

  let total = referenceCost * Math.max(0, input.missingReferenceCount);
  for (const shot of input.shots) {
    const cost = estimateShotVideoCostUsd(shot.durationSec);
    if (cost === null) return null;
    total += cost;
  }
  return Math.round(total * 10_000) / 10_000;
}

/** A költség magyar megjelenítése (ismeretlen árnál "ismeretlen"). */
export function formatCostText(cost: number | null | undefined): string {
  return formatCostUsd(cost);
}

/** A költségvetés magyar összefoglalója. */
export function formatBudgetSummary(summary: {
  budget_usd: number;
  spent_usd: number;
  open_reserved_usd: number;
  remaining_usd: number;
}): string {
  return `Keret: ${formatCostUsd(summary.budget_usd)} — elköltve: ${formatCostUsd(
    summary.spent_usd
  )} — nyitott foglalás: ${formatCostUsd(summary.open_reserved_usd)} — rendelkezésre áll: ${formatCostUsd(
    summary.remaining_usd
  )}`;
}

/**
 * Indítható-e a manuális újrapróbálás a keret alapján?
 *
 * A végső ellenőrzés mindig a szerveren fut (a `reserve_budget` atomi függvény),
 * ez a csak a UI figyelmeztetése.
 */
export function canAffordRetry(input: {
  remainingUsd: number;
  estimatedCostUsd: number | null;
  simulated: boolean;
}): { allowed: boolean; reason: string } {
  if (input.simulated) {
    return { allowed: true, reason: 'MOCK provider: nincs valós költség.' };
  }
  if (input.estimatedCostUsd === null) {
    return {
      allowed: false,
      reason: 'Az ár ismeretlen, ezért az újrapróbálás nem indítható.',
    };
  }
  if (input.remainingUsd < input.estimatedCostUsd) {
    return {
      allowed: false,
      reason: 'Nincs elég keret az újrapróbáláshoz (a szerver ezt amúgy is ellenőrzi).',
    };
  }
  return { allowed: true, reason: 'Az újrapróbálás indítható.' };
}
