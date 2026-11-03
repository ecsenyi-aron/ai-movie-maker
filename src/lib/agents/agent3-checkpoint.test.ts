import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getCheckpointData,
  recomputeUtteranceDuration,
  updateDialogueAndRecompute,
} from './agent3-checkpoint';

/**
 * Memóriában futó hamis Supabase kliens.
 * Csak azokat a műveleteket utánozza, amiket a checkpoint modul használ.
 */
type Row = Record<string, unknown>;

class FakeDb {
  tables: Record<string, Row[]> = {
    scenes: [],
    shots: [],
    utterances: [],
    timeline_items: [],
    media_assets: [],
    characters: [],
  };
  signedUrls: string[] = [];
  n = 0;

  from(table: string) {
    return makeBuilder(this, table);
  }

  storage = {
    from: () => ({
      createSignedUrl: async (path: string) => {
        this.signedUrls.push(path);
        return { data: { signedUrl: `https://signed.test/${path}` }, error: null };
      },
    }),
  };
}

function makeBuilder(db: FakeDb, table: string) {
  let op = 'select';
  let payload: Row | Row[] | undefined;
  const filters: Array<(r: Row) => boolean> = [];
  let single: null | 'single' | 'maybe' = null;

  const exec = () => {
    const rows = db.tables[table] ?? [];
    const match = () => rows.filter((r) => filters.every((f) => f(r)));

    if (op === 'insert') {
      const list = Array.isArray(payload) ? payload : [payload as Row];
      const out: Row[] = [];
      for (const p of list) {
        const row = { id: `id-${++db.n}`, ...p };
        rows.push(row);
        out.push(row);
      }
      if (single) return { data: out[0], error: null };
      return { data: out, error: null };
    }

    if (op === 'update') {
      const hit = match();
      hit.forEach((r) => Object.assign(r, payload));
      return { data: hit, error: null };
    }

    if (op === 'delete') {
      const hit = match();
      db.tables[table] = rows.filter((r) => !hit.includes(r));
      return { data: null, error: null };
    }

    const hit = match();
    if (single === 'single') {
      return hit.length === 1
        ? { data: hit[0], error: null }
        : { data: null, error: { message: 'nem egy sor' } };
    }
    if (single === 'maybe') {
      if (hit.length > 1) return { data: null, error: { message: 'több sor' } };
      return { data: hit[0] ?? null, error: null };
    }
    return { data: hit, error: null };
  };

  const builder: Record<string, unknown> = {
    select() {
      return builder;
    },
    insert(p: Row | Row[]) {
      op = 'insert';
      payload = p;
      return builder;
    },
    update(p: Row) {
      op = 'update';
      payload = p;
      return builder;
    },
    delete() {
      op = 'delete';
      return builder;
    },
    eq(column: string, value: unknown) {
      filters.push((r) => r[column] === value);
      return builder;
    },
    in(column: string, values: unknown[]) {
      filters.push((r) => values.includes(r[column]));
      return builder;
    },
    order() {
      return builder;
    },
    single() {
      single = 'single';
      return builder;
    },
    maybeSingle() {
      single = 'maybe';
      return builder;
    },
    then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
      return Promise.resolve(exec()).then(resolve, reject);
    },
  };

  return builder;
}

const PROJECT = 'proj-1';

/** Két jelenet, három felvétel: egy néma, egy beszédes, egy hosszú beszédes. */
function setup() {
  const db = new FakeDb();

  db.tables.scenes.push(
    { id: 'scene-2', project_id: PROJECT, number: 2 },
    { id: 'scene-1', project_id: PROJECT, number: 1 }
  );

  db.tables.shots.push(
    {
      id: 'shot-1-2',
      scene_id: 'scene-1',
      number: 2,
      dialogue_hu: 'Ne nyisd ki azt az ajtót.',
      target_duration_sec: 2,
      actual_duration_sec: null,
      duration_estimated: null,
      status: 'planned',
    },
    {
      id: 'shot-1-1',
      scene_id: 'scene-1',
      number: 1,
      dialogue_hu: '',
      target_duration_sec: 4,
      actual_duration_sec: null,
      duration_estimated: null,
      status: 'planned',
    },
    {
      id: 'shot-2-1',
      scene_id: 'scene-2',
      number: 1,
      dialogue_hu: 'Ez egy nagyon hosszú mondat, ami hosszabb a tervezett időnél.',
      target_duration_sec: 3,
      actual_duration_sec: null,
      duration_estimated: null,
      status: 'planned',
    }
  );

  db.tables.utterances.push(
    {
      id: 'utt-1',
      project_id: PROJECT,
      character_id: 'char-1',
      source_shot_id: 'shot-1-2',
      text_hu: 'Ne nyisd ki azt az ajtót.',
      audio_path: null,
      measured_duration_seconds: null,
      duration_estimated: true,
      version: 1,
    },
    {
      id: 'utt-2',
      project_id: PROJECT,
      character_id: null,
      source_shot_id: 'shot-2-1',
      text_hu: 'Ez egy nagyon hosszú mondat, ami hosszabb a tervezett időnél.',
      audio_path: 'audio/shot-2-1.wav',
      measured_duration_seconds: 9.5,
      duration_estimated: false,
      version: 1,
    }
  );

  db.tables.characters.push({ id: 'char-1', project_id: PROJECT, name: 'Anna' });

  db.tables.media_assets.push({
    id: 'media-1',
    project_id: PROJECT,
    shot_id: 'shot-2-1',
    type: 'audio',
    storage_path: 'audio/shot-2-1.wav',
    public_url: null,
    duration_sec: 9.5,
  });

  db.tables.timeline_items.push(
    {
      id: 'tl-1',
      project_id: PROJECT,
      track: 'video',
      shot_id: 'shot-1-1',
      utterance_id: null,
      start_seconds: 0,
      duration_seconds: 4,
      source_out: 4,
      sequence_order: 1,
    },
    {
      id: 'tl-2',
      project_id: PROJECT,
      track: 'subtitle',
      shot_id: 'shot-1-2',
      utterance_id: 'utt-1',
      start_seconds: 4,
      duration_seconds: 2,
      source_out: 2,
      sequence_order: 2,
    },
    {
      id: 'tl-3',
      project_id: PROJECT,
      track: 'video',
      shot_id: 'shot-2-1',
      utterance_id: null,
      start_seconds: 6,
      duration_seconds: 3,
      source_out: 3,
      sequence_order: 3,
    }
  );

  return db;
}

test('getCheckpointData: film sorrend, néma felvétel, becsült és mért időtartam', async () => {
  const db = setup();
  const data = await getCheckpointData(db as never, PROJECT);

  // Felvételek jelenet- és felvételszám szerint rendezve.
  assert.deepEqual(
    data.shots.map((s) => `${s.sceneNumber}.${s.shotNumber}`),
    ['1.1', '1.2', '2.1']
  );

  // A néma felvétel nincs a beszédek között.
  assert.equal(data.utterances.length, 2);
  assert.equal(data.utterances[0].shotId, 'shot-1-2');
  assert.equal(data.utterances[1].shotId, 'shot-2-1');

  // Szereplő neve látszik, ha ismert.
  assert.equal(data.utterances[0].speaker, 'Anna');
  assert.equal(data.utterances[1].speaker, null);

  // Hangfájl nélkül: nincs lejátszó, csak becslés.
  assert.equal(data.utterances[0].hasAudio, false);
  assert.equal(data.utterances[0].audioUrl, null);
  assert.equal(data.utterances[0].durationIsMeasured, false);
  assert.ok((data.utterances[0].estimatedDurationSec ?? 0) > 0);

  // Hangfájllal: van aláírt URL és mért időtartam.
  assert.equal(data.utterances[1].hasAudio, true);
  assert.equal(data.utterances[1].audioUrl, 'https://signed.test/audio/shot-2-1.wav');
  assert.equal(data.utterances[1].durationIsMeasured, true);
  assert.equal(data.utterances[1].durationSec, 9.5);

  // A hosszabb beszéd meghosszabbítja a felvételt.
  assert.equal(data.shots[2].lengthened, true);
  assert.equal(data.shots[0].lengthened, false);

  // Az időtartamok még nincsenek lezárva.
  assert.equal(data.durationsLocked, false);

  // Teljes hossz az idővonalból.
  assert.equal(data.totalDurationSec, 9);

  // TTS állapot: a környezeti változó nélkül "nincs bekapcsolva", költség ismeretlen.
  assert.equal(data.tts.enabled, false);
  assert.equal(data.tts.costStatus, 'ismeretlen');
});

test('getCheckpointData: csak az aktuális (legmagasabb) verzió látszik', async () => {
  const db = setup();
  db.tables.utterances.push({
    id: 'utt-1-v2',
    project_id: PROJECT,
    character_id: 'char-1',
    source_shot_id: 'shot-1-2',
    text_hu: 'Ne nyisd ki azt az ajtót!',
    audio_path: null,
    measured_duration_seconds: null,
    duration_estimated: true,
    version: 2,
  });

  const data = await getCheckpointData(db as never, PROJECT);
  const first = data.utterances.find((u) => u.shotId === 'shot-1-2');

  assert.ok(first);
  assert.equal(first.id, 'utt-1-v2');
  assert.equal(first.version, 2);
  assert.equal(first.hasOlderVersions, true);
  assert.equal(data.utterances.length, 2);
});

test('getCheckpointData: lezárt időtartamok jelennek meg, ha minden felvételnek van zárolt hossza', async () => {
  const db = setup();
  for (const shot of db.tables.shots) {
    shot.actual_duration_sec = 5;
    shot.duration_estimated = false;
  }

  const data = await getCheckpointData(db as never, PROJECT);
  assert.equal(data.durationsLocked, true);
  assert.equal(data.shots[0].lockedDurationSec, 5);
  assert.equal(data.shots[0].durationEstimated, false);
});

test('recomputeUtteranceDuration: csak az adott felvétel változik', async () => {
  const db = setup();
  const result = await recomputeUtteranceDuration(db as never, 'utt-1', PROJECT);

  assert.equal(result.success, true);

  const shot12 = db.tables.shots.find((s) => s.id === 'shot-1-2')!;
  const shot11 = db.tables.shots.find((s) => s.id === 'shot-1-1')!;
  const shot21 = db.tables.shots.find((s) => s.id === 'shot-2-1')!;

  // A szerkesztett felvétel kap új hosszt (a becslés alapján).
  assert.ok(Number(shot12.actual_duration_sec) > 2);
  assert.equal(shot12.duration_estimated, true);

  // A többi felvétel változatlan.
  assert.equal(shot11.actual_duration_sec, null);
  assert.equal(shot21.actual_duration_sec, null);

  // Az idővonalon csak az adott felvétel elemei frissülnek.
  const tl2 = db.tables.timeline_items.find((t) => t.id === 'tl-2')!;
  const tl1 = db.tables.timeline_items.find((t) => t.id === 'tl-1')!;
  const tl3 = db.tables.timeline_items.find((t) => t.id === 'tl-3')!;
  assert.equal(tl2.duration_seconds, shot12.actual_duration_sec);
  assert.equal(tl1.duration_seconds, 4);
  assert.equal(tl3.duration_seconds, 3);
});

test('recomputeUtteranceDuration: elavult verziót elutasít', async () => {
  const db = setup();
  db.tables.utterances.push({
    id: 'utt-1-v2',
    project_id: PROJECT,
    character_id: 'char-1',
    source_shot_id: 'shot-1-2',
    text_hu: 'Újabb szöveg.',
    audio_path: null,
    measured_duration_seconds: null,
    duration_estimated: true,
    version: 2,
  });

  const result = await recomputeUtteranceDuration(db as never, 'utt-1', PROJECT);
  assert.equal(result.success, false);
  assert.match(result.message, /elavult/i);
});

test('updateDialogueAndRecompute: új verzió jön létre, és csak annak a felvételnek az időtartama változik', async () => {
  const db = setup();
  const result = await updateDialogueAndRecompute(
    db as never,
    'utt-1',
    PROJECT,
    'Ne nyisd ki azt a másik ajtót sem.'
  );

  assert.equal(result.success, true);

  const versions = db.tables.utterances
    .filter((u) => u.source_shot_id === 'shot-1-2')
    .map((u) => u.version)
    .sort();
  assert.deepEqual(versions, [1, 2]);

  // A felvétel szövege frissült.
  const shot12 = db.tables.shots.find((s) => s.id === 'shot-1-2')!;
  assert.equal(shot12.dialogue_hu, 'Ne nyisd ki azt a másik ajtót sem.');

  // A feliratelem az új verzióra mutat.
  const newUtterance = db.tables.utterances.find((u) => u.version === 2)!;
  const tl2 = db.tables.timeline_items.find((t) => t.id === 'tl-2')!;
  assert.equal(tl2.utterance_id, newUtterance.id);
  assert.notEqual(tl2.utterance_id, 'utt-1');

  // A többi felvétel időtartama változatlan.
  const shot11 = db.tables.shots.find((s) => s.id === 'shot-1-1')!;
  const shot21 = db.tables.shots.find((s) => s.id === 'shot-2-1')!;
  assert.equal(shot11.actual_duration_sec, null);
  assert.equal(shot21.actual_duration_sec, null);
});

test('updateDialogueAndRecompute: üres szöveget elutasít', async () => {
  const db = setup();
  const result = await updateDialogueAndRecompute(db as never, 'utt-1', PROJECT, '   ');
  assert.equal(result.success, false);
  assert.equal(db.tables.utterances.length, 2);
});
