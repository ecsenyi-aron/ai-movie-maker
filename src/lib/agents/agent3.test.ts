import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildUtterances,
  lockDurations,
  synthesizeUtterance,
  updateDialogueVersion,
} from './agent3';
import {
  calculateWavDuration,
  computeShotDuration,
  estimateSpeechDuration,
  pickCurrentUtterances,
  sortShots,
} from './agent3-helpers';

// ---------------------------------------------------------------------------
// Memóriában futó hamis Supabase (csak amit az Agent 3 használ)
// ---------------------------------------------------------------------------
class FakeDb {
  tables: Record<string, any[]> = {
    scenes: [], shots: [], utterances: [], timeline_items: [], generation_jobs: [],
  };
  failOn: { table: string; op: string } | null = null;
  n = 0;
  from(table: string) {
    return makeBuilder(this, table);
  }
}

function uniqueConflict(db: FakeDb, table: string, row: any): boolean {
  const rows = db.tables[table];
  if (table === 'utterances' && row.source_shot_id) {
    return rows.some((r) => r.source_shot_id === row.source_shot_id && r.version === row.version);
  }
  if (table === 'timeline_items') {
    if (row.track === 'video') return rows.some((r) => r.track === 'video' && r.shot_id === row.shot_id);
    if (row.track === 'subtitle' && row.utterance_id)
      return rows.some((r) => r.track === 'subtitle' && r.utterance_id === row.utterance_id);
  }
  return false;
}

function makeBuilder(db: FakeDb, table: string) {
  let op = 'select';
  let payload: any;
  const filters: Array<(r: any) => boolean> = [];
  let single: null | 'single' | 'maybe' = null;
  let returning = false;

  const exec = () => {
    if (db.failOn && db.failOn.table === table && db.failOn.op === op) {
      return { data: null, error: { message: 'szimulált hiba', code: 'XX000' } };
    }
    const rows = db.tables[table];
    const match = () => rows.filter((r) => filters.every((f) => f(r)));
    if (op === 'insert') {
      const list = Array.isArray(payload) ? payload : [payload];
      const out: any[] = [];
      for (const p of list) {
        if (uniqueConflict(db, table, p)) {
          return { data: null, error: { message: 'duplicate key value', code: '23505' } };
        }
        const row = { id: `id-${++db.n}`, ...p };
        rows.push(row);
        out.push(row);
      }
      if (single) return { data: out[0], error: null };
      return { data: returning ? out : null, error: null };
    }
    if (op === 'update') {
      const hit = match();
      hit.forEach((r) => Object.assign(r, payload));
      return { data: returning ? hit : null, error: null };
    }
    if (op === 'delete') {
      const hit = match();
      db.tables[table] = rows.filter((r) => !hit.includes(r));
      return { data: null, error: null };
    }
    const hit = match();
    if (single === 'single') {
      return hit.length === 1 ? { data: hit[0], error: null } : { data: null, error: { message: 'nem egy sor' } };
    }
    if (single === 'maybe') {
      if (hit.length > 1) return { data: null, error: { message: 'több sor' } };
      return { data: hit[0] ?? null, error: null };
    }
    return { data: hit, error: null };
  };

  const b: any = {
    select() { returning = true; return b; },
    insert(p: any) { op = 'insert'; payload = p; return b; },
    update(p: any) { op = 'update'; payload = p; return b; },
    delete() { op = 'delete'; return b; },
    eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
    in(c: string, vs: any[]) { filters.push((r) => vs.includes(r[c])); return b; },
    order() { return b; },
    single() { single = 'single'; return b; },
    maybeSingle() { single = 'maybe'; return b; },
    then(res: any, rej: any) { return Promise.resolve(exec()).then(res, rej); },
  };
  return b;
}

const P = 'proj-1';

/** Két jelenet, amelyeknek az azonosítója fordított sorrendben rendeződik a számukhoz képest. */
function setup() {
  const db = new FakeDb();
  db.tables.scenes.push(
    { id: 'zzz-scene-1', project_id: P, number: 1 },
    { id: 'aaa-scene-2', project_id: P, number: 2 },
  );
  db.tables.shots.push(
    { id: 's2a', scene_id: 'aaa-scene-2', number: 1, dialogue_hu: '', target_duration_sec: 3, status: 'planned' },
    { id: 's1b', scene_id: 'zzz-scene-1', number: 2, dialogue_hu: 'Ne nyisd ki azt az ajtót.', target_duration_sec: 2, status: 'planned' },
    { id: 's1a', scene_id: 'zzz-scene-1', number: 1, dialogue_hu: '', target_duration_sec: 4, status: 'planned' },
  );
  return db;
}

const asClient = (db: FakeDb) => db as any;

// ---------------------------------------------------------------------------
// Tesztek
// ---------------------------------------------------------------------------
test('rendezés: jelenetszám szerint, nem azonosító szerint', () => {
  const db = setup();
  const sorted = sortShots(db.tables.scenes as any, db.tables.shots as any);
  assert.deepEqual(sorted.map((s) => s.id), ['s1a', 's1b', 's2a']);
  assert.deepEqual(sorted.map((s) => s.position), [1, 2, 3]);
});

test('buildUtterances: globális sorrend, üres párbeszéd kimarad', async () => {
  const db = setup();
  const r = await buildUtterances(asClient(db), P);
  assert.equal(r.success, true);
  const video = db.tables.timeline_items.filter((t) => t.track === 'video');
  const order = Object.fromEntries(video.map((t) => [t.shot_id, t.sequence_order]));
  assert.deepEqual(order, { s1a: 1, s1b: 2, s2a: 3 });
  assert.equal(db.tables.utterances.length, 1); // csak az s1b-nek van párbeszéde
  const sub = db.tables.timeline_items.filter((t) => t.track === 'subtitle');
  assert.equal(sub.length, 1);
  assert.equal(sub[0].sequence_order, 2); // ugyanaz a pozíció, mint a videóelemé
});

test('újrafuttatás nem hoz létre duplikátumot', async () => {
  const db = setup();
  await buildUtterances(asClient(db), P);
  await buildUtterances(asClient(db), P);
  assert.equal(db.tables.utterances.length, 1);
  assert.equal(db.tables.timeline_items.length, 3 + 1);
});

test('szerkesztés utáni újrafuttatás: nincs duplikátum, az új verzió él', async () => {
  const db = setup();
  await buildUtterances(asClient(db), P);
  const v1 = db.tables.utterances[0];
  const r = await updateDialogueVersion(asClient(db), v1.id, P, 'Soha ne nyisd ki azt az ajtót!');
  assert.equal(r.success, true);
  await buildUtterances(asClient(db), P);
  assert.equal(db.tables.utterances.length, 2); // v1 megmarad, v2 új
  const subs = db.tables.timeline_items.filter((t) => t.track === 'subtitle');
  assert.equal(subs.length, 1);
  const v2 = db.tables.utterances.find((u) => u.version === 2);
  assert.equal(subs[0].utterance_id, v2.id);
  assert.equal(db.tables.shots.find((s) => s.id === 's1b').dialogue_hu, 'Soha ne nyisd ki azt az ajtót!');
});

test('lockDurations: csendes felvétel nem becsült, beszédes igen', async () => {
  const db = setup();
  await buildUtterances(asClient(db), P);
  const r = await lockDurations(asClient(db), P);
  assert.equal(r.success, true);
  const get = (id: string) => db.tables.shots.find((s) => s.id === id);
  assert.equal(get('s1a').duration_estimated, false);
  assert.equal(get('s2a').duration_estimated, false);
  assert.equal(get('s1b').duration_estimated, true);
  assert.equal(get('s1a').status, 'audio_ready');
});

test('lockDurations: nem rontja vissza a már kész felvétel állapotát', async () => {
  const db = setup();
  db.tables.shots.find((s) => s.id === 's1a').status = 'clip_ready';
  await buildUtterances(asClient(db), P);
  await lockDurations(asClient(db), P);
  assert.equal(db.tables.shots.find((s) => s.id === 's1a').status, 'clip_ready');
});

test('lockDurations: a legmagasabb verziót használja, és nem rövidebb a beszédnél', async () => {
  const db = setup();
  await buildUtterances(asClient(db), P);
  const v1 = db.tables.utterances[0];
  const hosszu = Array.from({ length: 30 }, (_, i) => `szó${i}`).join(' ');
  await updateDialogueVersion(asClient(db), v1.id, P, hosszu);
  await lockDurations(asClient(db), P);
  const shot = db.tables.shots.find((s) => s.id === 's1b');
  assert.equal(shot.actual_duration_sec, estimateSpeechDuration(hosszu));
  assert.ok(shot.actual_duration_sec > 2);
  const tl = db.tables.timeline_items.find((t) => t.track === 'video' && t.shot_id === 's1b');
  assert.equal(tl.duration_seconds, shot.actual_duration_sec);
});

test('lockDurations: az idővonal kezdőidői sorban követik egymást', async () => {
  const db = setup();
  await buildUtterances(asClient(db), P);
  await lockDurations(asClient(db), P);
  const v = (id: string) => db.tables.timeline_items.find((t) => t.track === 'video' && t.shot_id === id);
  assert.equal(v('s1a').start_seconds, 0);
  assert.equal(v('s1b').start_seconds, v('s1a').duration_seconds);
  assert.equal(v('s2a').start_seconds, v('s1a').duration_seconds + v('s1b').duration_seconds);
});

test('sikertelen írás: success false, nem hamis siker', async () => {
  const db = setup();
  db.failOn = { table: 'timeline_items', op: 'insert' };
  const r = await buildUtterances(asClient(db), P);
  assert.equal(r.success, false);
  assert.match(r.message, /Hiba történt/);

  const db2 = setup();
  await buildUtterances(asClient(db2), P);
  db2.failOn = { table: 'shots', op: 'update' };
  const r2 = await lockDurations(asClient(db2), P);
  assert.equal(r2.success, false);
});

test('szerkesztés: üres szöveg elutasítva', async () => {
  const db = setup();
  await buildUtterances(asClient(db), P);
  const r = await updateDialogueVersion(asClient(db), db.tables.utterances[0].id, P, '   ');
  assert.equal(r.success, false);
  assert.equal(db.tables.utterances.length, 1);
});

test('szerkesztés: hiba esetén az idővonal nem mutat nem létező beszédre', async () => {
  const db = setup();
  await buildUtterances(asClient(db), P);
  const v1 = db.tables.utterances[0];
  db.failOn = { table: 'shots', op: 'update' };
  const r = await updateDialogueVersion(asClient(db), v1.id, P, 'Új szöveg');
  assert.equal(r.success, false);
  const sub = db.tables.timeline_items.find((t) => t.track === 'subtitle');
  assert.equal(sub.utterance_id, v1.id);
  assert.equal(db.tables.utterances.length, 1); // az új verzió visszavonva
});

test('szerkesztés: idegen projekt beszéde nem szerkeszthető', async () => {
  const db = setup();
  await buildUtterances(asClient(db), P);
  const r = await updateDialogueVersion(asClient(db), db.tables.utterances[0].id, 'masik-projekt', 'Szöveg');
  assert.equal(r.success, false);
});

test('TTS: kikapcsolva felirat-tartalék, bekapcsolva (nincs megvalósítva) hiba; egyik sem hoz létre jobot', async () => {
  const db = setup();
  await buildUtterances(asClient(db), P);
  const id = db.tables.utterances[0].id;

  delete process.env.TTS_ENABLED;
  const off = await synthesizeUtterance(asClient(db), id, P);
  assert.equal(off.success, true);
  assert.equal(off.data.label, 'becsült időtartam');

  process.env.TTS_ENABLED = 'true';
  const on = await synthesizeUtterance(asClient(db), id, P);
  assert.equal(on.success, false);
  assert.match(on.message, /nincs ellenőrizve\/megvalósítva/);
  delete process.env.TTS_ENABLED;

  assert.equal(db.tables.generation_jobs.length, 0);
});

test('segédfüggvények: aktuális verzió, hosszok, WAV', () => {
  const m = pickCurrentUtterances([
    { source_shot_id: 'a', version: 1, id: 'x' } as any,
    { source_shot_id: 'a', version: 3, id: 'y' } as any,
    { source_shot_id: 'a', version: 2, id: 'z' } as any,
  ]);
  assert.equal((m.get('a') as any).id, 'y');
  // 48000 bájt = 24000 minta 16 biten, 24 kHz mellett = 1 s
  assert.equal(calculateWavDuration(48000), 1);
  const d = computeShotDuration({ targetSeconds: 2, dialogue: 'egy' });
  assert.equal(d.estimated, true);
  assert.equal(d.duration, 2.0);
  const measured = computeShotDuration({
    targetSeconds: 2, dialogue: 'szöveg',
    utterance: { audio_path: 'p/a.wav', measured_duration_seconds: 5.5, text_hu: 'szöveg' },
  });
  assert.deepEqual(measured, { duration: 5.5, estimated: false, lengthened: true });
});
