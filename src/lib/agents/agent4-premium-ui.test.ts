/**
 * Agent 4 — Prémium UI segédfüggvények automatikus tesztek.
 *
 * Tiszta függvények: nincs hálózat, nincs adatbázis, nincs fizetős hívás.
 *
 * Futtatás:  npx tsx --test src/lib/agents/agent4-premium-ui.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canAffordRetry,
  estimateProjectCostUsd,
  estimateShotVideoCostUsd,
  formatBudgetSummary,
  formatCostText,
  referenceStatusLabel,
  resolveReferenceStatus,
  resolveShotReferenceOwner,
  resolveVideoStatus,
  videoStatusLabel,
  type UiJob,
  type UiReference,
} from './agent4-premium-ui.ts';

// ---------------------------------------------------------------------------
// Segédadatok
// ---------------------------------------------------------------------------

const CHARACTERS = [
  { id: 'char-1', name: 'Anna' },
  { id: 'char-2', name: 'Béla' },
];

const LOCATION = { id: 'loc-1', name: 'Cafe' };

function makeJob(overrides: Partial<UiJob> = {}): UiJob {
  return {
    id: 'job-1',
    shot_id: null,
    step: 'reference_image',
    provider: 'mock',
    attempt: 1,
    status: 'pending',
    error: null,
    reference_owner_type: 'character',
    reference_owner_id: 'char-1',
    estimated_cost_usd: 0,
    ...overrides,
  };
}

function makeReference(overrides: Partial<UiReference> = {}): UiReference {
  return {
    id: 'ref-1',
    owner_type: 'character',
    owner_id: 'char-1',
    status: 'approved',
    storage_path: 'proj-1/references/character-char-1-ref-1.png',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A) A felvétel referencia-tulajdonosa
// ---------------------------------------------------------------------------

test('UI: pontosan egy főszereplő esetén a karakter a referencia-tulajdonos', () => {
  const owner = resolveShotReferenceOwner({
    featuredCharacterIds: ['char-1'],
    speakerCharacterId: null,
    characters: CHARACTERS,
    location: LOCATION,
  });
  assert.deepEqual(owner, { type: 'character', id: 'char-1', name: 'Anna' });
});

test('UI: több főszereplő esetén nincs referencia-tulajdonos', () => {
  const owner = resolveShotReferenceOwner({
    featuredCharacterIds: ['char-1', 'char-2'],
    speakerCharacterId: null,
    characters: CHARACTERS,
    location: LOCATION,
  });
  assert.equal(owner, null);
});

test('UI: főszereplő nélkül a helyszín a referencia-tulajdonos', () => {
  const owner = resolveShotReferenceOwner({
    featuredCharacterIds: [],
    speakerCharacterId: null,
    characters: CHARACTERS,
    location: LOCATION,
  });
  assert.deepEqual(owner, { type: 'location', id: 'loc-1', name: 'Cafe' });
});

test('UI: főszereplő nélkül, de egy beszélővel a beszélő karaktere', () => {
  const owner = resolveShotReferenceOwner({
    featuredCharacterIds: [],
    speakerCharacterId: 'char-2',
    characters: CHARACTERS,
    location: LOCATION,
  });
  assert.deepEqual(owner, { type: 'character', id: 'char-2', name: 'Béla' });
});

test('UI: sem karakter, sem helyszín nélkül nincs tulajdonos', () => {
  const owner = resolveShotReferenceOwner({
    featuredCharacterIds: [],
    speakerCharacterId: null,
    characters: [],
    location: null,
  });
  assert.equal(owner, null);
});

// ---------------------------------------------------------------------------
// B) A magyar feliratok
// ---------------------------------------------------------------------------

test('UI: a referencia állapotok magyar feliratai', () => {
  assert.equal(referenceStatusLabel('ready'), 'kész');
  assert.equal(referenceStatusLabel('pending'), 'folyamatban');
  assert.equal(referenceStatusLabel('failed'), 'sikertelen');
  assert.equal(referenceStatusLabel('uncertain'), 'bizonytalan');
  assert.equal(referenceStatusLabel('missing'), 'hiányzik');
});

test('UI: a videó állapotok magyar feliratai', () => {
  assert.equal(videoStatusLabel('ready'), 'kész');
  assert.equal(videoStatusLabel('pending'), 'folyamatban');
  assert.equal(videoStatusLabel('failed'), 'sikertelen');
  assert.equal(videoStatusLabel('uncertain'), 'bizonytalan');
  assert.equal(videoStatusLabel('not_started'), 'még nem indult');
});

// ---------------------------------------------------------------------------
// C) A referencia állapotának feloldása
// ---------------------------------------------------------------------------

test('UI: a jóváhagyott referencia "kész" állapotot ad', () => {
  const status = resolveReferenceStatus({
    ownerType: 'character',
    ownerId: 'char-1',
    references: [makeReference()],
    jobs: [],
  });
  assert.equal(status, 'ready');
});

test('UI: a jóváhagyott, de tárolási út nélküli referencia nem számít késznek', () => {
  const status = resolveReferenceStatus({
    ownerType: 'character',
    ownerId: 'char-1',
    references: [makeReference({ storage_path: null })],
    jobs: [],
  });
  assert.equal(status, 'missing');
});

test('UI: a futó referencia feladat "folyamatban" állapotot ad', () => {
  const status = resolveReferenceStatus({
    ownerType: 'character',
    ownerId: 'char-1',
    references: [],
    jobs: [makeJob({ status: 'submitted' })],
  });
  assert.equal(status, 'pending');
});

test('UI: a bizonytalan referencia feladat "bizonytalan" állapotot ad', () => {
  const status = resolveReferenceStatus({
    ownerType: 'character',
    ownerId: 'char-1',
    references: [],
    jobs: [makeJob({ status: 'uncertain' })],
  });
  assert.equal(status, 'uncertain');
});

test('UI: a sikertelen referencia feladat "sikertelen" állapotot ad', () => {
  const status = resolveReferenceStatus({
    ownerType: 'character',
    ownerId: 'char-1',
    references: [],
    jobs: [makeJob({ status: 'failed' })],
  });
  assert.equal(status, 'failed');
});

test('UI: a másik tulajdonos feladata nem számít ide tartozónak', () => {
  const status = resolveReferenceStatus({
    ownerType: 'character',
    ownerId: 'char-2',
    references: [],
    jobs: [makeJob({ reference_owner_id: 'char-1', status: 'submitted' })],
  });
  assert.equal(status, 'missing');
});

// ---------------------------------------------------------------------------
// D) A videó állapotának feloldása
// ---------------------------------------------------------------------------

test('UI: a meglévő médiafájl "kész" videóállapotot ad', () => {
  const view = resolveVideoStatus({ shotId: 'shot-1', jobs: [], hasAsset: true });
  assert.equal(view.status, 'ready');
  assert.equal(view.label, 'kész');
  assert.equal(view.error, null);
});

test('UI: a futó videó feladat "folyamatban" állapotot ad', () => {
  const view = resolveVideoStatus({
    shotId: 'shot-1',
    jobs: [makeJob({ step: 'video', shot_id: 'shot-1', status: 'processing' })],
    hasAsset: false,
  });
  assert.equal(view.status, 'pending');
  assert.equal(view.error, null);
});

test('UI: a bizonytalan videó magyar figyelmeztetéssel jelzi, hogy nem indult új kérés', () => {
  const view = resolveVideoStatus({
    shotId: 'shot-1',
    jobs: [makeJob({ step: 'video', shot_id: 'shot-1', status: 'uncertain' })],
    hasAsset: false,
  });
  assert.equal(view.status, 'uncertain');
  assert.ok(view.error?.includes('új fizetős kérés nem indult'));
});

test('UI: a sikertelen videó a magyar hibaüzenetet megőrzi', () => {
  const view = resolveVideoStatus({
    shotId: 'shot-1',
    jobs: [
      makeJob({
        step: 'video',
        shot_id: 'shot-1',
        status: 'failed',
        error: 'A videó készítése nem sikerült.',
      }),
    ],
    hasAsset: false,
  });
  assert.equal(view.status, 'failed');
  assert.equal(view.error, 'A videó készítése nem sikerült.');
});

test('UI: a másik felvétel videófeladata nem számít ide', () => {
  const view = resolveVideoStatus({
    shotId: 'shot-1',
    jobs: [makeJob({ step: 'video', shot_id: 'shot-2', status: 'failed' })],
    hasAsset: false,
  });
  assert.equal(view.status, 'not_started');
  assert.equal(view.label, 'még nem indult');
});

// ---------------------------------------------------------------------------
// E) A költségbecslés és a formázás
// ---------------------------------------------------------------------------

test('UI: a felvétel videóköltsége a hivatalos másodpercenkénti áron', () => {
  // 0,084 USD/mp * 5 mp = 0,42 USD
  assert.equal(estimateShotVideoCostUsd(5), 0.42);
});

test('UI: ismeretlen vagy nulla időtartalomnál nincs költségbecslés', () => {
  assert.equal(estimateShotVideoCostUsd(null), null);
  assert.equal(estimateShotVideoCostUsd(0), null);
  assert.equal(estimateShotVideoCostUsd(undefined), null);
});

test('UI: a teljes projekt becslése a referenciákat és a videókat is összeadja', () => {
  const total = estimateProjectCostUsd({
    missingReferenceCount: 1,
    shots: [{ durationSec: 5 }, { durationSec: 5 }],
  });
  assert.ok(total !== null);
  // 1 referencia (0,003 * 0,9216 MP) + 2 videó (0,42 + 0,42)
  assert.ok(Math.abs((total ?? 0) - (0.0027648 + 0.84)) < 0.0001);
});

test('UI: a költség formázása az ismeretlen árat "ismeretlen"-ként írja', () => {
  assert.equal(formatCostText(null), 'ismeretlen');
  assert.equal(formatCostText(undefined), 'ismeretlen');
  assert.ok(formatCostText(0.42).includes('0.42'));
});

test('UI: a költségvetés összefoglalója magyarul tartalmazza a keretet és a maradékot', () => {
  const summary = formatBudgetSummary({
    budget_usd: 10,
    spent_usd: 2.5,
    open_reserved_usd: 0.5,
    remaining_usd: 7,
  });
  assert.ok(summary.includes('Keret'));
  assert.ok(summary.includes('rendelkezésre áll'));
  assert.ok(summary.includes('7'));
});

// ---------------------------------------------------------------------------
// F) Az újrapróbálás indíthatósága
// ---------------------------------------------------------------------------

test('UI: MOCK provider esetén az újrapróbálás mindig indítható', () => {
  const decision = canAffordRetry({
    remainingUsd: 0,
    estimatedCostUsd: 0.42,
    simulated: true,
  });
  assert.equal(decision.allowed, true);
  assert.ok(decision.reason.includes('MOCK'));
});

test('UI: ismeretlen árnál az újrapróbálás nem indítható', () => {
  const decision = canAffordRetry({
    remainingUsd: 100,
    estimatedCostUsd: null,
    simulated: false,
  });
  assert.equal(decision.allowed, false);
  assert.ok(decision.reason.includes('ismeretlen'));
});

test('UI: nem elég keret esetén az újrapróbálás nem indítható', () => {
  const decision = canAffordRetry({
    remainingUsd: 0.1,
    estimatedCostUsd: 0.42,
    simulated: false,
  });
  assert.equal(decision.allowed, false);
  assert.ok(decision.reason.includes('Nincs elég keret'));
});

test('UI: elegendő keret esetén az újrapróbálás indítható', () => {
  const decision = canAffordRetry({
    remainingUsd: 5,
    estimatedCostUsd: 0.42,
    simulated: false,
  });
  assert.equal(decision.allowed, true);
});
