/**
 * Agent 4 (Stock / Pixabay) automatikus tesztek.
 *
 * Nincs hálózat és nincs valódi adatbázis: a `fetch` le van cserélve
 * hamis implementációra, az adatbázis pedig memóriában futó hamis kliens
 * (ugyanaz a minta, mint az agent3.test.ts fájlban).
 *
 * Futtatás:  node --test src/lib/agents/agent4.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildAttribution,
  extractKeywords,
  MAX_CLIP_BYTES,
  pickClip,
  validateDownload,
  type PixabayHit,
} from './agent4-stock.ts';
import { advance } from './agent4.ts';

// ---------------------------------------------------------------------------
// Memóriában futó hamis Supabase
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

class FakeDb {
  tables: Record<string, Row[]> = {
    projects: [],
    scenes: [],
    shots: [],
    generation_jobs: [],
    media_assets: [],
    characters: [],
    timeline_items: [],
    stock_search_cache: [],
  };
  failOn: { table: string; op: string } | null = null;
  /**
   * Szimulált egyedi kulcsütközés (23505) a generation_jobs beszúrásakor:
   * a sor ilyenkor egy "párhuzamos" jobot jelent, amely már létezik.
   */
  insertConflict: { table: string; row: Row } | null = null;
  userId = 'user-1';
  uploads: string[] = [];
  n = 0;

  auth = {
    getUser: async () => ({ data: { user: { id: this.userId } }, error: null }),
  };

  storage = {
    from: () => ({
      upload: async (path: string) => {
        this.uploads.push(path);
        return { error: null };
      },
      list: async () => ({ data: [], error: null }),
    }),
  };

  from(table: string) {
    return makeBuilder(this, table);
  }
}

interface FakeBuilder {
  select(): FakeBuilder;
  insert(payload: unknown): FakeBuilder;
  upsert(payload: unknown): FakeBuilder;
  update(payload: unknown): FakeBuilder;
  delete(): FakeBuilder;
  eq(column: string, value: unknown): FakeBuilder;
  in(column: string, values: unknown[]): FakeBuilder;
  order(): FakeBuilder;
  single(): FakeBuilder;
  maybeSingle(): FakeBuilder;
  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2>;
}

function makeBuilder(db: FakeDb, table: string): FakeBuilder {
  let op = 'select';
  let payload: unknown;
  const filters: Array<(r: Row) => boolean> = [];
  let single: null | 'single' | 'maybe' = null;
  let returning = false;

  const exec = () => {
    if (db.failOn && db.failOn.table === table && db.failOn.op === op) {
      return { data: null, error: { message: 'szimulált hiba', code: 'XX000' } };
    }
    const rows = db.tables[table] ?? [];
    const match = () => rows.filter((r) => filters.every((f) => f(r)));

    if (op === 'insert') {
      if (db.insertConflict && db.insertConflict.table === table) {
        // A párhuzamos beszúrás "nyert": a sor már létezik az adatbázisban.
        rows.push({ id: `id-${++db.n}`, ...db.insertConflict.row });
        return {
          data: null,
          error: {
            message: 'duplicate key value violates unique constraint "generation_jobs_unique"',
            code: '23505',
          },
        };
      }
      const list = Array.isArray(payload) ? payload : [payload];
      const out: Row[] = [];
      for (const p of list) {
        const row = { id: `id-${++db.n}`, ...(p as Row) };
        rows.push(row);
        out.push(row);
      }
      if (single === 'single') return { data: out[0], error: null };
      return { data: returning ? out : null, error: null };
    }

    if (op === 'upsert') {
      const list = Array.isArray(payload) ? payload : [payload];
      const out: Row[] = [];
      for (const p of list) {
        const item = p as Row;
        const existing = rows.find((r) => r.query_key === item.query_key);
        if (existing) {
          Object.assign(existing, item);
          out.push(existing);
        } else {
          const row = { id: `id-${++db.n}`, ...item };
          rows.push(row);
          out.push(row);
        }
      }
      return { data: returning ? out : null, error: null };
    }

    if (op === 'update') {
      const hit = match();
      const item = (payload ?? {}) as Row;
      hit.forEach((r) => Object.assign(r, item));
      return { data: returning ? hit : null, error: null };
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

  const b: FakeBuilder = {
    select() {
      returning = true;
      return b;
    },
    insert(p: unknown) {
      op = 'insert';
      payload = p;
      return b;
    },
    upsert(p: unknown) {
      op = 'upsert';
      payload = p;
      return b;
    },
    update(p: unknown) {
      op = 'update';
      payload = p;
      return b;
    },
    delete() {
      op = 'delete';
      return b;
    },
    eq(c: string, v: unknown) {
      filters.push((r) => r[c] === v);
      return b;
    },
    in(c: string, vs: unknown[]) {
      filters.push((r) => vs.includes(r[c]));
      return b;
    },
    order() {
      return b;
    },
    single() {
      single = 'single';
      return b;
    },
    maybeSingle() {
      single = 'maybe';
      return b;
    },
    then(onfulfilled, onrejected) {
      return Promise.resolve(exec()).then(onfulfilled, onrejected);
    },
  };
  return b;
}

const asClient = (db: FakeDb): SupabaseClient => db as unknown as SupabaseClient;

// ---------------------------------------------------------------------------
// Hamis hálózat
// ---------------------------------------------------------------------------

const MP4_BYTES = (() => {
  const bytes = new Uint8Array(64);
  bytes.set([0x00, 0x00, 0x00, 0x18], 0);
  bytes.set([0x66, 0x74, 0x79, 0x70], 4); // 'ftyp'
  bytes.set([0x69, 0x73, 0x6f, 0x6d], 8); // 'isom'
  return bytes;
})();

function landscapeHit(id: number, duration: number, size = 1024): PixabayHit {
  return {
    id,
    pageURL: `https://pixabay.com/videos/video-${id}/`,
    duration,
    user: 'TesztElefánt',
    user_id: 42,
    tags: 'forest river',
    videos: {
      large: { url: `https://cdn.test/${id}-large.mp4`, width: 1920, height: 1080, size: 0 },
      small: { url: `https://cdn.test/${id}-small.mp4`, width: 1280, height: 720, size },
      tiny: { url: `https://cdn.test/${id}-tiny.mp4`, width: 640, height: 360, size: Math.floor(size / 4) },
    },
  };
}

interface FetchOptions {
  hits?: PixabayHit[];
  status?: number;
  remaining?: string;
  downloadOk?: boolean;
}

function installFetch(options: FetchOptions = {}) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('pixabay.com/api/videos/')) {
      const status = options.status ?? 200;
      const headers = new Headers();
      if (options.remaining !== undefined) headers.set('x-ratelimit-remaining', options.remaining);
      if (status === 429) {
        return new Response(JSON.stringify({ error: 'Too many requests' }), {
          status: 429,
          headers,
        });
      }
      return new Response(JSON.stringify({ total: options.hits?.length ?? 0, hits: options.hits ?? [] }), {
        status,
        headers,
      });
    }
    if (options.downloadOk === false) {
      return new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } });
    }
    return new Response(MP4_BYTES, {
      status: 200,
      headers: { 'content-type': 'video/mp4', 'content-length': String(MP4_BYTES.byteLength) },
    });
  }) as typeof globalThis.fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

// ---------------------------------------------------------------------------
// Adatbázis előkészítése
// ---------------------------------------------------------------------------

const PROJECT_ID = 'proj-1';

function setupDb(opts: { approved?: boolean; mode?: string; characters?: number } = {}) {
  const db = new FakeDb();
  db.tables.projects.push({
    id: PROJECT_ID,
    user_id: 'user-1',
    title: 'Teszt film',
    mode: opts.mode ?? 'stock',
    status: opts.approved === false ? 'awaiting_approval' : 'approved',
    approved_at: opts.approved === false ? null : new Date().toISOString(),
  });
  db.tables.scenes.push({ id: 'scene-1', project_id: PROJECT_ID, number: 1 });
  db.tables.shots.push({
    id: 'shot-1',
    scene_id: 'scene-1',
    number: 1,
    visual_prompt_en: 'Aerial view of a forest river with cinematic bokeh',
    target_duration_sec: 4,
    actual_duration_sec: 4,
    status: 'audio_ready',
    qc_notes: null,
  });
  for (let i = 0; i < (opts.characters ?? 0); i++) {
    db.tables.characters.push({ id: `char-${i}`, project_id: PROJECT_ID, name: `Szereplő ${i}` });
  }
  return db;
}

function withKey<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.PIXABAY_API_KEY;
  process.env.PIXABAY_API_KEY = 'teszt-kulcs';
  return fn().finally(() => {
    if (previous === undefined) delete process.env.PIXABAY_API_KEY;
    else process.env.PIXABAY_API_KEY = previous;
  });
}

// ---------------------------------------------------------------------------
// Tiszta segédfüggvények
// ---------------------------------------------------------------------------

test('extractKeywords: kamerás szavak és stopwordok kiesnek, 2–4 szó, determinisztikus', () => {
  const q = extractKeywords('Aerial view of a forest river with cinematic bokeh');
  assert.equal(q, 'forest river');
  assert.equal(extractKeywords('Aerial view of a forest river with cinematic bokeh'), q);

  const many = extractKeywords('forest river mountain fog sunrise');
  assert.ok(many.split(' ').length <= 4);

  const long = extractKeywords('alpha bravo charlie delta echo foxtrot golf hotel india juliet');
  assert.ok(long.length <= 100);
});

test('extractKeywords: üres prompt esetén üres string', () => {
  assert.equal(extractKeywords(''), '');
  assert.equal(extractKeywords('   '), '');
});

test('pickClip: a legrövidebb elég hosszú fekvő felvétel nyer', () => {
  const hits = [landscapeHit(1, 20), landscapeHit(2, 8), landscapeHit(3, 5)];
  const picked = pickClip(hits, 4);
  assert.ok(picked);
  // Az 5 másodperces klip is elég hosszú (4 mp kell), ezért az nyer.
  assert.equal(picked?.hit.id, 3);
  assert.equal(picked?.renditionKey, 'small');
});

test('pickClip: ha egyik sem elég hosszú, null (nincs "legközelebbi" trükk)', () => {
  const hits = [landscapeHit(1, 3), landscapeHit(2, 2)];
  assert.equal(pickClip(hits, 4), null);
});

test('pickClip: az álló (portrait) felvétel kimarad', () => {
  const portrait = landscapeHit(9, 30);
  portrait.videos!.small = { url: 'https://cdn.test/p.mp4', width: 720, height: 1280, size: 1000 };
  const picked = pickClip([portrait], 4);
  assert.equal(picked, null);
});

test('pickClip: a méretlimit fölötti felvétel kimarad', () => {
  const tooBig = landscapeHit(10, 30, MAX_CLIP_BYTES + 1);
  assert.equal(pickClip([tooBig], 4), null);
});

test('pickClip: ha nincs small, a tiny használható', () => {
  const hit = landscapeHit(11, 30);
  delete hit.videos!.small;
  const picked = pickClip([hit], 4);
  assert.equal(picked?.renditionKey, 'tiny');
});

test('buildAttribution: a Pixabay oldalára hivatkozó forrásmegjelölés', () => {
  const text = buildAttribution(landscapeHit(5, 10));
  assert.match(text, /Videó: TesztElefánt \/ Pixabay/);
  assert.match(text, /pixabay\.com\/videos\/video-5/);
});

test('validateDownload: üres fájl elutasítva', () => {
  const r = validateDownload(new Uint8Array(0), { contentType: 'video/mp4' });
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /üres/);
});

test('validateDownload: nem video típus elutasítva', () => {
  const r = validateDownload(MP4_BYTES, { contentType: 'text/html' });
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /nem videó/);
});

test('validateDownload: túl nagy fájl elutasítva', () => {
  const r = validateDownload(MP4_BYTES, {
    contentType: 'video/mp4',
    contentLength: MAX_CLIP_BYTES + 1,
  });
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /nagyobb/);
});

test('validateDownload: nem MP4 aláírás elutasítva', () => {
  const notMp4 = new Uint8Array(32);
  notMp4.set([0x89, 0x50, 0x4e, 0x47], 0);
  const r = validateDownload(notMp4, { contentType: 'video/mp4' });
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /MP4/);
});

test('validateDownload: érvényes MP4 átmegy', () => {
  const r = validateDownload(MP4_BYTES, { contentType: 'video/mp4' });
  assert.equal(r.ok, true);
});

// ---------------------------------------------------------------------------
// advance()
// ---------------------------------------------------------------------------

test('advance: jóváhagyás előtt semmi nem történik', async () => {
  const db = setupDb({ approved: false });
  const net = installFetch();
  try {
    const r = await advance(asClient(db), asClient(db), PROJECT_ID);
    assert.equal(r.success, false);
    assert.match(r.message, /jóváhagyva/);
    assert.equal(db.tables.generation_jobs.length, 0);
    assert.equal(net.calls.length, 0);
  } finally {
    net.restore();
  }
});

test('advance: idegen projekt elutasítva', async () => {
  const db = setupDb();
  db.userId = 'other-user';
  const net = installFetch();
  try {
    const r = await advance(asClient(db), asClient(db), PROJECT_ID);
    assert.equal(r.success, false);
    assert.match(r.message, /Nincs jogosultságod/);
    assert.equal(db.tables.generation_jobs.length, 0);
  } finally {
    net.restore();
  }
});

test('advance: nem stock mód esetén elutasítva', async () => {
  const db = setupDb({ mode: 'premium' });
  const net = installFetch();
  try {
    const r = await advance(asClient(db), asClient(db), PROJECT_ID);
    assert.equal(r.success, false);
    assert.match(r.message, /Stock mód/);
  } finally {
    net.restore();
  }
});

test('advance: egyszerre csak egy futó feladat lehet', async () => {
  const db = setupDb();
  db.tables.generation_jobs.push({
    id: 'job-running',
    project_id: PROJECT_ID,
    shot_id: 'shot-1',
    provider: 'pixabay',
    step: 'stock',
    attempt: 1,
    status: 'processing',
  });
  const net = installFetch();
  try {
    const r = await advance(asClient(db), asClient(db), PROJECT_ID);
    assert.equal(r.success, false);
    assert.equal(r.message, 'folyamatban');
    assert.equal(net.calls.length, 0);
  } finally {
    net.restore();
  }
});

test('advance: siker esetén pontosan egy médiafájl, idővonal-link és clip_ready', async () => {
  const db = setupDb();
  const net = installFetch({ hits: [landscapeHit(100, 12)] });
  try {
    const r = await withKey(() => advance(asClient(db), asClient(db), PROJECT_ID));
    assert.equal(r.success, true, r.message);

    assert.equal(db.tables.media_assets.length, 1);
    const asset = db.tables.media_assets[0];
    assert.equal(asset.type, 'video');
    assert.equal(asset.provider, 'pixabay');
    assert.equal(asset.source_label, 'stock_library');
    assert.equal(asset.public_url, null);
    assert.match(String(asset.attribution), /Pixabay/);
    assert.equal(asset.duration_sec, 12);

    const video = db.tables.timeline_items.filter((t) => t.track === 'video');
    assert.equal(video.length, 1);
    assert.equal(video[0].media_asset_id, asset.id);
    assert.equal(video[0].shot_id, 'shot-1');

    const shot = db.tables.shots.find((s) => s.id === 'shot-1')!;
    assert.equal(shot.status, 'clip_ready');
    assert.equal(shot.qc_technical, 'pending');

    const job = db.tables.generation_jobs.find((j) => j.step === 'stock')!;
    assert.equal(job.status, 'succeeded');
    assert.equal(job.actual_cost_usd, 0);
    assert.equal(db.uploads.length, 1);
  } finally {
    net.restore();
  }
});

test('advance: újrafuttatás nem hoz létre duplikátumot', async () => {
  const db = setupDb();
  const net = installFetch({ hits: [landscapeHit(101, 12)] });
  try {
    await withKey(() => advance(asClient(db), asClient(db), PROJECT_ID));
    const second = await withKey(() => advance(asClient(db), asClient(db), PROJECT_ID));
    assert.equal(second.success, true);
    assert.equal(second.message, 'nincs több teendő');
    assert.equal(db.tables.media_assets.length, 1);
    assert.equal(db.tables.timeline_items.filter((t) => t.track === 'video').length, 1);
  } finally {
    net.restore();
  }
});

test('advance: a gyorsítótár miatt a második kérés nem hívja újra a Pixabay-t', async () => {
  const db = setupDb();
  const net = installFetch({ hits: [] });
  try {
    // Első lépés: nincs találat -> needs_review, a keresés gyorsítótárazva.
    const first = await withKey(() => advance(asClient(db), asClient(db), PROJECT_ID));
    assert.equal(first.success, false);
    const searchCalls = net.calls.filter((c) => c.includes('pixabay.com/api/videos/')).length;
    assert.ok(searchCalls >= 1);

    // Második lépés: ugyanaz a felvétel újrapróbálása, a gyorsítótárból olvasva.
    const second = await withKey(() => advance(asClient(db), asClient(db), PROJECT_ID));
    assert.equal(second.success, false);
    const searchCallsAfter = net.calls.filter((c) => c.includes('pixabay.com/api/videos/')).length;
    assert.equal(searchCallsAfter, searchCalls, 'a gyorsítótárazott keresés nem hívja újra a Pixabay-t');
  } finally {
    net.restore();
  }
});

test('advance: 429 esetén a feladat failed, magyar üzenettel', async () => {
  const db = setupDb();
  const net = installFetch({ status: 429 });
  try {
    const r = await withKey(() => advance(asClient(db), asClient(db), PROJECT_ID));
    assert.equal(r.success, false);
    assert.match(r.message, /429|túl sok kérést/);
    const job = db.tables.generation_jobs.find((j) => j.step === 'stock')!;
    assert.equal(job.status, 'failed');
    assert.match(String(job.error), /429|túl sok kérést/);
    assert.equal(db.tables.media_assets.length, 0);
  } finally {
    net.restore();
  }
});

test('advance: rate limit (X-RateLimit-Remaining: 0) esetén magyar korlát-üzenet', async () => {
  const db = setupDb();
  const net = installFetch({ hits: [], remaining: '0' });
  try {
    const r = await withKey(() => advance(asClient(db), asClient(db), PROJECT_ID));
    assert.equal(r.success, false);
    assert.match(r.message, /korlát elérve/);
    const job = db.tables.generation_jobs.find((j) => j.step === 'stock')!;
    assert.equal(job.status, 'failed');
  } finally {
    net.restore();
  }
});

test('advance: ha nincs találat, needs_review, és nincs médiafájl', async () => {
  const db = setupDb();
  const net = installFetch({ hits: [] });
  try {
    const r = await withKey(() => advance(asClient(db), asClient(db), PROJECT_ID));
    assert.equal(r.success, false);
    assert.match(r.message, /Nincs megfelelő stock felvétel/);
    const shot = db.tables.shots.find((s) => s.id === 'shot-1')!;
    assert.equal(shot.status, 'needs_review');
    assert.match(String(shot.qc_notes), /Helyettesítő képkocka/);
    assert.equal(db.tables.media_assets.length, 0);
    assert.equal(db.tables.timeline_items.length, 0);
  } finally {
    net.restore();
  }
});

test('advance: sikertelen írás esetén success:false (nincs hamis siker)', async () => {
  const db = setupDb();
  db.failOn = { table: 'media_assets', op: 'insert' };
  const net = installFetch({ hits: [landscapeHit(102, 12)] });
  try {
    const r = await withKey(() => advance(asClient(db), asClient(db), PROJECT_ID));
    assert.equal(r.success, false);
    assert.match(r.message, /Hiba történt/);
    const job = db.tables.generation_jobs.find((j) => j.step === 'stock')!;
    assert.equal(job.status, 'failed');
  } finally {
    net.restore();
  }
});

test('advance: szereplős projektnél a felvétel needs_review a helyettesítő megjegyzéssel', async () => {
  const db = setupDb({ characters: 1 });
  const net = installFetch({ hits: [landscapeHit(103, 12)] });
  try {
    const r = await withKey(() => advance(asClient(db), asClient(db), PROJECT_ID));
    assert.equal(r.success, true, r.message);
    const shot = db.tables.shots.find((s) => s.id === 'shot-1')!;
    assert.equal(shot.status, 'needs_review');
    assert.match(String(shot.qc_notes), /Helyettesítő felvétel: a szereplő és a helyszín nem biztosan egyezik/);
    assert.equal(db.tables.media_assets.length, 1);
  } finally {
    net.restore();
  }
});

test('advance: ugyanaz a Pixabay videó nem töltődik le kétszer egy projektben', async () => {
  const db = setupDb();
  db.tables.media_assets.push({
    id: 'asset-existing',
    project_id: PROJECT_ID,
    shot_id: 'shot-0',
    type: 'video',
    storage_path: `${PROJECT_ID}/shot-0/pixabay-200-small.mp4`,
    public_url: null,
    duration_sec: 12,
    provider: 'pixabay',
    attribution: 'Videó: TesztElefánt / Pixabay – https://pixabay.com/videos/video-200/',
    lipsync_applied: false,
    source_label: 'stock_library',
  });
  const net = installFetch({ hits: [landscapeHit(200, 12)] });
  try {
    const r = await withKey(() => advance(asClient(db), asClient(db), PROJECT_ID));
    assert.equal(r.success, true, r.message);
    assert.equal(r.data?.reused, true);
    assert.equal(db.tables.media_assets.length, 1, 'nem jön létre új médiafájl');
    assert.equal(db.uploads.length, 0, 'nem töltjük le újra');
    const video = db.tables.timeline_items.filter((t) => t.track === 'video');
    assert.equal(video.length, 1);
    assert.equal(video[0].media_asset_id, 'asset-existing');
  } finally {
    net.restore();
  }
});

test('advance: egyedi kulcsütközés a futó job meglévőnek számít, nem általános hiba', async () => {
  const db = setupDb();
  db.insertConflict = {
    table: 'generation_jobs',
    row: {
      id: 'job-parallel',
      project_id: PROJECT_ID,
      shot_id: 'shot-1',
      provider: 'pixabay',
      step: 'stock',
      attempt: 1,
      status: 'processing',
    },
  };
  const net = installFetch({ hits: [landscapeHit(105, 12)] });
  try {
    const r = await withKey(() => advance(asClient(db), asClient(db), PROJECT_ID));
    assert.equal(r.success, false);
    assert.equal(r.message, 'folyamatban');
    assert.equal(db.tables.media_assets.length, 0);
    assert.equal(net.calls.length, 0, 'ütközésnél nincs hálózati kérés');
  } finally {
    net.restore();
  }
});

test('advance: egyedi kulcsütközésnél már lezárt job esetén magyar "már létezik" üzenet', async () => {
  const db = setupDb();
  db.insertConflict = {
    table: 'generation_jobs',
    row: {
      id: 'job-done',
      project_id: PROJECT_ID,
      shot_id: 'shot-1',
      provider: 'pixabay',
      step: 'stock',
      attempt: 1,
      status: 'failed',
    },
  };
  const net = installFetch({ hits: [landscapeHit(106, 12)] });
  try {
    const r = await withKey(() => advance(asClient(db), asClient(db), PROJECT_ID));
    assert.equal(r.success, false);
    assert.match(r.message, /már létezik/);
    assert.equal(db.tables.media_assets.length, 0);
  } finally {
    net.restore();
  }
});

test('advance: hiányzó Pixabay-kulcs esetén világos magyar hiba, nem hamis eredmény', async () => {
  const db = setupDb();
  const net = installFetch({ hits: [landscapeHit(104, 12)] });
  const previous = process.env.PIXABAY_API_KEY;
  delete process.env.PIXABAY_API_KEY;
  try {
    const r = await advance(asClient(db), asClient(db), PROJECT_ID);
    assert.equal(r.success, false);
    assert.match(r.message, /PIXABAY_API_KEY/);
    assert.equal(db.tables.media_assets.length, 0);
    assert.equal(net.calls.length, 0);
  } finally {
    if (previous !== undefined) process.env.PIXABAY_API_KEY = previous;
    net.restore();
  }
});
