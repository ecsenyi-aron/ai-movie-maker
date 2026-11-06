/**
 * Agent 4 — Prémium döntési réteg (tiszta függvények) automatikus tesztek.
 *
 * Nincs hálózat, nincs adatbázis, nincs fizetős hívás.
 *
 * Futtatás:  npx tsx --test src/lib/agents/agent4-premium-plan.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFailureNote,
  computeVideoDuration,
  estimatePhaseCostUsd,
  estimateReferenceCostUsd,
  formatCostUsd,
  isPhaseConfigured,
  isStepAttemptAllowed,
  selectNextPhase,
  shouldOfferStockFallback,
} from './agent4-premium-plan.ts';
import {
  FAL_ENDPOINTS,
  FAL_REFERENCE_IMAGE_MEGAPIXELS,
  MOCK_LABEL,
  MOCK_SIMULATED_COST_USD,
  estimateStepCostUsd,
  getPremiumConfigStatus,
  isStepConfigured,
  pickSupportedDuration,
} from './agent4-premium-config.ts';

// ---------------------------------------------------------------------------
// A) Prompt komponens: FIXED STYLE MARKER minden kép promptban
//    (a részletes tesztek az agent4-composer.test.ts fájlban vannak)
// ---------------------------------------------------------------------------

test('a FIXED STYLE MARKER a központi konfigurációból jön (egyetlen forrás)', async () => {
  const { FIXED_STYLE_MARKER, COMPOSER_CONFIG } = await import('./agent4-composer.ts');
  assert.equal(COMPOSER_CONFIG.styleMarker, FIXED_STYLE_MARKER);
  assert.ok(FIXED_STYLE_MARKER.length > 0);
});

// ---------------------------------------------------------------------------
// B) Referencia készültség: a videó csak a referenciák után indulhat
// ---------------------------------------------------------------------------

test('fázissorrend: a referenciák készülnek el előbb, csak utána jön a videó', () => {
  const decision = selectNextPhase({
    hasPendingReferenceJobs: false,
    missingReferenceCount: 2,
    pendingVideoShotCount: 3,
  });
  assert.equal(decision.phase, 'reference');
  assert.ok(decision.reason.includes('2'));
});

test('fázissorrend: futó referencia feladatnál csak lekérdezés történhet', () => {
  const decision = selectNextPhase({
    hasPendingReferenceJobs: true,
    missingReferenceCount: 0,
    pendingVideoShotCount: 3,
  });
  assert.equal(decision.phase, 'reference');
  assert.ok(decision.reason.includes('lekérdezés'));
});

test('fázissorrend: csak a referenciák után indulhat a videó', () => {
  const decision = selectNextPhase({
    hasPendingReferenceJobs: false,
    missingReferenceCount: 0,
    pendingVideoShotCount: 3,
  });
  assert.equal(decision.phase, 'video');
});

test('fázissorrend: nincs teendő, ha minden kész', () => {
  const decision = selectNextPhase({
    hasPendingReferenceJobs: false,
    missingReferenceCount: 0,
    pendingVideoShotCount: 0,
  });
  assert.equal(decision.phase, 'done');
});

// ---------------------------------------------------------------------------
// C) Egy próbálkozás szabály (nincs automatikus újrapróbálás)
// ---------------------------------------------------------------------------

test('egy próbálkozás: az első kérés engedélyezett', () => {
  const decision = isStepAttemptAllowed({ existingAttempts: 0, manualRetry: false });
  assert.equal(decision.allowed, true);
});

test('egy próbálkozás: automatikus újrapróbálás nincs', () => {
  const decision = isStepAttemptAllowed({ existingAttempts: 1, manualRetry: false });
  assert.equal(decision.allowed, false);
  assert.ok(decision.reason.includes('manuálisan'));
});

test('egy próbálkozás: manuális újrapróbálás engedélyezett', () => {
  const decision = isStepAttemptAllowed({ existingAttempts: 1, manualRetry: true });
  assert.equal(decision.allowed, true);
  assert.ok(decision.reason.includes('költségvetési'));
});

// ---------------------------------------------------------------------------
// D) Videó időtartam: az Agent 3 hanghosszát követi, nem lehet rövidebb a hangnál
// ---------------------------------------------------------------------------

test('videóidőtartam: a hangnál soha nem rövidebb', () => {
  const decision = computeVideoDuration({
    desiredSec: 4,
    audioSec: 4.5,
    supported: [3, 4, 5, 6, 7, 8, 9, 10],
  });
  assert.equal(decision.durationSec, 5);
  assert.equal(decision.needsReview, false);
});

test('videóidőtartam: a hanghosszhoz felkerekítve', () => {
  const decision = computeVideoDuration({
    desiredSec: 4,
    audioSec: 4.5,
    supported: [3, 4, 5, 6, 7, 8, 9, 10],
  });
  assert.ok((decision.durationSec ?? 0) >= 4.5);
});

test('videóidőtartam: ha nincs elég hosszú támogatott érték, kézi ellenőrzés kell', () => {
  const decision = computeVideoDuration({
    desiredSec: 12,
    audioSec: 12,
    supported: [3, 4, 5],
  });
  assert.equal(decision.durationSec, null);
  assert.equal(decision.needsReview, true);
  assert.ok(decision.reason.includes('12'));
});

test('videóidőtartam: támogatott érték hiányában kézi ellenőrzés', () => {
  const decision = computeVideoDuration({
    desiredSec: 4,
    audioSec: null,
    supported: [],
  });
  assert.equal(decision.durationSec, null);
  assert.equal(decision.needsReview, true);
});

test('videóidőtartam: a támogatott értékek közül a legkisebb megfelelőt választja', () => {
  const decision = computeVideoDuration({
    desiredSec: 5,
    audioSec: null,
    supported: [3, 4, 5, 6, 7, 8, 9, 10],
  });
  assert.equal(decision.durationSec, 5);
});

test('videóidőtartam: a hivatalos Kling értékek mind használhatók', () => {
  const supported = FAL_ENDPOINTS.video.supportedDurationsSec ?? [];
  assert.deepEqual(supported, [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  for (const seconds of supported) {
    const decision = computeVideoDuration({
      desiredSec: seconds,
      audioSec: seconds,
      supported,
    });
    assert.equal(decision.durationSec, seconds);
  }
});

// ---------------------------------------------------------------------------
// E) Költségvetés: ismeretlen ár esetén a valódi provider tiltva marad
// ---------------------------------------------------------------------------

test('költség: a referencia kép becslése a hivatalos megapixel áron', () => {
  const cost = estimateReferenceCostUsd();
  assert.ok(cost !== null);
  assert.equal(cost, Math.round(0.003 * FAL_REFERENCE_IMAGE_MEGAPIXELS * 10_000) / 10_000);
});

test('költség: a videó becslése a hivatalos másodpercenkénti áron', () => {
  const cost = estimateStepCostUsd('video', { durationSec: 5 });
  assert.equal(cost, 0.42);
});

test('költség: ismeretlen ár esetén null (a UI "ismeretlen"-t mutat)', () => {
  assert.equal(estimateStepCostUsd('video', { durationSec: 0 }), null);
  assert.equal(estimateStepCostUsd('reference_image', { megapixels: 0 }), null);
});

test('költség: a formázás az ismeretlen árat "ismeretlen"-ként írja', () => {
  assert.equal(formatCostUsd(null), 'ismeretlen');
  assert.equal(formatCostUsd(undefined), 'ismeretlen');
  assert.equal(formatCostUsd(0.42), '$0.4200');
});

test('költség: a fázis becslése a megfelelő lépés ára', () => {
  assert.equal(estimatePhaseCostUsd('reference'), estimateReferenceCostUsd());
  assert.equal(estimatePhaseCostUsd('video', { durationSec: 5 }), 0.42);
  assert.equal(estimatePhaseCostUsd('video'), null);
});

test('költség: a MOCK szimulált költsége 0, és külön van a valós költségtől', () => {
  assert.equal(MOCK_SIMULATED_COST_USD, 0);
  assert.ok((estimateStepCostUsd('video', { durationSec: 5 }) ?? 0) > 0);
});

// ---------------------------------------------------------------------------
// F) Premium letiltás: nincs kulcs vagy ismeretlen ár esetén
// ---------------------------------------------------------------------------

test('premium: kulcs nélkül MOCK mód, kulccsal valós mód', () => {
  assert.equal(getPremiumConfigStatus(null), 'mock');
  assert.equal(getPremiumConfigStatus(''), 'mock');
  assert.equal(getPremiumConfigStatus('   '), 'mock');
  assert.equal(getPremiumConfigStatus('teszt-kulcs'), 'real');
});

test('premium: minden ellenőrzött lépés konfigurált (endpoint + ismert ár)', () => {
  assert.equal(isStepConfigured('reference_image'), true);
  assert.equal(isStepConfigured('video'), true);
  assert.equal(isPhaseConfigured('reference'), true);
  assert.equal(isPhaseConfigured('video'), true);
});

test('premium: a MOCK címke jól látható MOCK / TESZT jelölést tartalmaz', () => {
  assert.ok(MOCK_LABEL.includes('MOCK / TESZT'));
});

// ---------------------------------------------------------------------------
// G) Stock helyettesítő felajánlása
// ---------------------------------------------------------------------------

test('stock helyettesítő: sikertelen lépés után felajánlható', () => {
  assert.equal(shouldOfferStockFallback({ jobFailed: true, shotAlreadyReady: false }), true);
});

test('stock helyettesítő: kész felvételnél nem kell', () => {
  assert.equal(shouldOfferStockFallback({ jobFailed: true, shotAlreadyReady: true }), false);
});

test('stock helyettesítő: sikertelen lépés nélkül nem kell', () => {
  assert.equal(shouldOfferStockFallback({ jobFailed: false, shotAlreadyReady: false }), false);
});

test('hibajegyzet: magyar szöveget ad, és a Stock helyettesítőt felajánlja', () => {
  const note = buildFailureNote('video', 'teszt hiba');
  assert.ok(note.includes('nem sikerült'));
  assert.ok(note.includes('teszt hiba'));
  assert.ok(note.includes('Stock helyettesítő'));
});

// ---------------------------------------------------------------------------
// H) Támogatott időtartam kiválasztása (a konfigurációból)
// ---------------------------------------------------------------------------

test('támogatott időtartam: a legkisebb megfelelő értéket adja', () => {
  assert.equal(pickSupportedDuration('video', 4), 4);
  assert.equal(pickSupportedDuration('video', 4.2), 5);
});

test('támogatott időtartam: ha nincs elég hosszú érték, null', () => {
  assert.equal(pickSupportedDuration('video', 20), null);
});
