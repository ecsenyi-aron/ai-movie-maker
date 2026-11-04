/**
 * Az Agent 4 előkészítő lépéseinek (hívási sorrend) tesztje.
 *
 * Nincs hálózat és nincs valódi adatbázis: a hívott függvényt hamis
 * implementációval helyettesítjük.
 *
 * Futtatás:  npx.cmd tsx --test src/lib/agents/agent4-prepare.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareShotsForStock,
  type PrepareAction,
  type PrepareStepResult,
} from './agent4-prepare';

test('előkészítés: build_utterances, majd lock_durations sorrendben fut le', async () => {
  const calls: PrepareAction[] = [];

  const result = await prepareShotsForStock(async (action) => {
    calls.push(action);
    return { ok: true, message: 'rendben' };
  });

  assert.equal(result.success, true);
  assert.deepEqual(calls, ['build_utterances', 'lock_durations']);
  assert.deepEqual(result.calls, ['build_utterances', 'lock_durations']);
});

test('előkészítés: ha a build_utterances hibázik, a lock_durations nem fut le', async () => {
  const calls: PrepareAction[] = [];

  const result = await prepareShotsForStock(async (action) => {
    calls.push(action);
    const step: PrepareStepResult = { ok: false, message: 'adatbázis hiba' };
    return step;
  });

  assert.equal(result.success, false);
  assert.deepEqual(calls, ['build_utterances']);
  assert.match(result.message, /beszédek előkészítése nem sikerült/);
  assert.match(result.message, /adatbázis hiba/);
});

test('előkészítés: ha a lock_durations hibázik, magyar hibaüzenet', async () => {
  const calls: PrepareAction[] = [];

  const result = await prepareShotsForStock(async (action) => {
    calls.push(action);
    if (action === 'build_utterances') return { ok: true, message: 'rendben' };
    return { ok: false, message: 'időtartam hiba' };
  });

  assert.equal(result.success, false);
  assert.deepEqual(calls, ['build_utterances', 'lock_durations']);
  assert.match(result.message, /időtartamok lezárása nem sikerült/);
  assert.match(result.message, /időtartam hiba/);
});
