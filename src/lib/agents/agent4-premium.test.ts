/**
 * Agent 4 — Prémium munkafolyamat automatikus tesztek.
 *
 * Nincs valódi API-kulcs, nincs valódi adatbázis, nincs fizetős hívás.
 * A provider és a költségvetés injektált (hamis) implementáció.
 *
 * Futtatás:  npx tsx --test src/lib/agents/agent4-premium.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { advancePremium, type PremiumBudgetApi } from './agent4-premium.ts';
import {
  MockProvider,
  type PremiumProvider,
  type ProviderPollOutcome,
  type ProviderStep,
  type ProviderSubmitOutcome,
  type ProviderVideoElement,
} from './agent4-provider.ts';
import { MOCK_LABEL } from './agent4-premium-config.ts';
import { validateDownload } from './agent4-stock.ts';
import { linkTimelineItem } from './agent4.ts';

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
    locations: [],
    reference_versions: [],
    timeline_items: [],
  };
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
      createSignedUrl: async (path: string) => ({
        data: { signedUrl: `https://storage.test/${path}?token=teszt` },
        error: null,
      }),
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
  update(payload: unknown): FakeBuilder;
  delete(): FakeBuilder;
  eq(column: string, value: unknown): FakeBuilder;
  in(column: string, values: unknown[]): FakeBuilder;
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
    const rows = db.tables[table] ?? [];
    const match = () => rows.filter((r) => filters.every((f) => f(r)));

    if (op === 'insert') {
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
// Hamis költségvetés
// ---------------------------------------------------------------------------

interface BudgetCall {
  kind: 'reserve' | 'settle' | 'release';
  jobId: string;
  amountUsd: number;
}

function makeBudget(options: { allow?: boolean; reason?: string } = {}) {
  const calls: BudgetCall[] = [];
  const api: PremiumBudgetApi = {
    reserve: async (_projectId, jobId, amountUsd) => {
      calls.push({ kind: 'reserve', jobId, amountUsd });
      return {
        ok: options.allow ?? true,
        reason: options.reason ?? 'nincs hiba',
        remaining: 10,
      };
    },
    settle: async (jobId, actualUsd) => {
      calls.push({ kind: 'settle', jobId, amountUsd: actualUsd });
      return 'settled';
    },
    release: async (jobId) => {
      calls.push({ kind: 'release', jobId, amountUsd: 0 });
    },
  };
  return { api, calls };
}

// ---------------------------------------------------------------------------
// "Fizetős" tesztprovider (nem szimulált -> a valós árat használja)
// ---------------------------------------------------------------------------

type TestOutcome = 'success' | 'failed' | 'uncertain';

interface PaidLikeOptions {
  outcomes?: Partial<Record<ProviderStep, TestOutcome>>;
  /** Bizonytalan kimenet provider feladatazonosító nélkül (nincs mit lekérdezni). */
  uncertainWithoutJobId?: boolean;
}

/**
 * Nem szimulált tesztprovider.
 *
 * A MOCK provider 0 USD-es szimulált költséget használ, ezért nála a
 * költségvetési foglalás sosem fut le. Ez a provider viszont "fizetős"
 * (a `simulated` jelző hamis), így a prémium kód a hivatalos árral számol
 * és a költségvetési foglalás is lefut. Hálózatot nem használ.
 */
class PaidLikeProvider implements PremiumProvider {
  readonly id = 'fal';
  readonly sourceLabel = 'fal';
  readonly simulated = false;
  readonly outcomes: Partial<Record<ProviderStep, TestOutcome>>;
  readonly submits: ProviderStep[] = [];
  /** A videó kérésekben kapott `elements` tömbök (multi-reference). */
  readonly videoElements: ProviderVideoElement[][] = [];
  /** A videó kérésekben kapott promptok. */
  readonly videoPrompts: string[] = [];
  private readonly uncertainWithoutJobId: boolean;
  private readonly inner = new MockProvider();

  constructor(options: PaidLikeOptions = {}) {
    this.outcomes = options.outcomes ?? {};
    this.uncertainWithoutJobId = options.uncertainWithoutJobId === true;
  }

  private outcomeFor(step: ProviderStep): TestOutcome {
    return this.outcomes[step] ?? 'success';
  }

  private uncertainOutcome(step: ProviderStep, jobId: string): ProviderSubmitOutcome {
    if (this.uncertainWithoutJobId) {
      return {
        ok: false,
        uncertain: true,
        error: 'A tesztprovider bizonytalan kimenetet ad (azonosító nélkül).',
      };
    }
    return {
      ok: false,
      uncertain: true,
      providerJobId: jobId,
      error: 'A tesztprovider bizonytalan kimenetet ad.',
    };
  }

  async submitReferenceImage(input: { prompt: string }): Promise<ProviderSubmitOutcome> {
    this.submits.push('reference_image');
    const outcome = this.outcomeFor('reference_image');
    if (outcome === 'failed') return { ok: false, error: 'A tesztprovider szimulált hibája.' };
    if (outcome === 'uncertain') return this.uncertainOutcome('reference_image', 'paid-ref-1');
    return { ok: true, providerJobId: `paid-ref-1:${input.prompt.length}` };
  }

  async submitVideo(input: {
    prompt: string;
    imageUrl: string;
    durationSec: number;
    elements?: ProviderVideoElement[];
  }): Promise<ProviderSubmitOutcome> {
    this.submits.push('video');
    this.videoElements.push(input.elements ?? []);
    this.videoPrompts.push(input.prompt);
    const outcome = this.outcomeFor('video');
    if (outcome === 'failed') return { ok: false, error: 'A tesztprovider szimulált hibája.' };
    if (outcome === 'uncertain') return this.uncertainOutcome('video', 'paid-video-1');
    return { ok: true, providerJobId: `paid-video-1:${input.durationSec}` };
  }

  async submitLipsync(input: { videoUrl: string; audioUrl: string }): Promise<ProviderSubmitOutcome> {
    this.submits.push('lipsync');
    return { ok: true, providerJobId: `paid-lip-1:${input.videoUrl.length}` };
  }

  async poll(step: ProviderStep, providerJobId: string): Promise<ProviderPollOutcome> {
    const outcome = this.outcomeFor(step);
    if (outcome === 'failed') {
      return { status: 'failed', error: 'A tesztprovider szimulált hibája.' };
    }
    if (outcome === 'uncertain') {
      return { status: 'processing', error: 'A tesztprovider még bizonytalan.' };
    }
    return this.inner.poll(step, providerJobId);
  }
}

// ---------------------------------------------------------------------------
// Adatbázis előkészítése
// ---------------------------------------------------------------------------

const PROJECT_ID = 'proj-premium-1';

interface SetupOptions {
  approved?: boolean;
  mode?: string;
  withCharacter?: boolean;
  withLocation?: boolean;
  shotCount?: number;
  referenceReady?: boolean;
}

function setupDb(opts: SetupOptions = {}) {
  const db = new FakeDb();
  db.tables.projects.push({
    id: PROJECT_ID,
    user_id: 'user-1',
    title: 'Prémium teszt film',
    mode: opts.mode ?? 'premium',
    status: 'approved',
    approved_at: opts.approved === false ? null : new Date().toISOString(),
    lipsync: false,
  });
  db.tables.scenes.push({ id: 'scene-1', project_id: PROJECT_ID, number: 1, location_id: 'loc-1' });

  const shotCount = opts.shotCount ?? 1;
  for (let i = 1; i <= shotCount; i += 1) {
    db.tables.shots.push({
      id: `shot-${i}`,
      scene_id: 'scene-1',
      number: i,
      visual_prompt_en: `Anna walks through the rainy street, shot ${i}`,
      camera_movement: 'slow_pan',
      target_duration_sec: 4,
      actual_duration_sec: 4,
      status: 'audio_ready',
      qc_notes: null,
      speaker_character_id: 'char-1',
      featured_character_ids: ['char-1'],
    });
  }

  if (opts.withCharacter !== false) {
    db.tables.characters.push({
      id: 'char-1',
      project_id: PROJECT_ID,
      name: 'Anna',
      canonical_description: 'short dark hair, red coat',
    });
  }
  if (opts.withLocation !== false) {
    db.tables.locations.push({
      id: 'loc-1',
      project_id: PROJECT_ID,
      name: 'Cafe',
      canonical_description: 'small wooden cafe interior',
      continuity: { environmental_attributes: 'warm afternoon light' },
    });
  }

  if (opts.referenceReady) {
    db.tables.reference_versions.push({
      id: 'ref-1',
      project_id: PROJECT_ID,
      owner_type: 'character',
      owner_id: 'char-1',
      version: 1,
      storage_path: `${PROJECT_ID}/references/character-char-1-ref-1.png`,
      status: 'approved',
    });
  }

  return db;
}

// ---------------------------------------------------------------------------
// A) Referencia kép készül el (MOCK provider)
// ---------------------------------------------------------------------------

test('prémium: a referencia kép elkészül és a privát media bucketbe kerül', async () => {
  const db = setupDb({ withLocation: false });
  const budget = makeBudget();
  const result = await advancePremium(asClient(db), asClient(db), PROJECT_ID, {
    budget: budget.api,
    provider: new MockProvider(),
  });

  assert.equal(result.success, true);
  assert.equal(result.data?.phase, 'reference');
  assert.equal(db.tables.reference_versions.length, 1);
  assert.equal(db.tables.reference_versions[0].owner_type, 'character');
  assert.equal(db.tables.reference_versions[0].status, 'approved');
  assert.ok(String(db.tables.reference_versions[0].storage_path).includes('/references/'));
  assert.ok(db.uploads.some((path) => path.includes('/references/')));
});

test('prémium: a referencia kép pontosan egyszer készül el (a meglévő újrahasznosul)', async () => {
  const db = setupDb({ withLocation: false, referenceReady: true });
  const budget = makeBudget();
  const result = await advancePremium(asClient(db), asClient(db), PROJECT_ID, {
    budget: budget.api,
    provider: new MockProvider(),
  });

  // A referencia már megvan -> a folyamat a videó fázisba lép.
  assert.equal(result.success, true);
  assert.equal(result.data?.phase, 'video');
  assert.equal(db.tables.reference_versions.length, 1);
});

// ---------------------------------------------------------------------------
// B) A videó csak a referenciák után készül, film sorrendben
// ---------------------------------------------------------------------------

test('prémium: a videó nem indulhat el, ha a referencia még hiányzik', async () => {
  const db = setupDb({ withLocation: false });
  const budget = makeBudget();
  // A referencia nélkül a folyamat a referenciát készíti, nem a videót.
  const result = await advancePremium(asClient(db), asClient(db), PROJECT_ID, {
    budget: budget.api,
    provider: new MockProvider(),
  });
  assert.equal(result.data?.phase, 'reference');
  assert.equal(db.tables.media_assets.length, 0);
});

test('prémium: a videó film sorrendben készül (először az 1. felvétel)', async () => {
  const db = setupDb({ withLocation: false, referenceReady: true, shotCount: 2 });
  const budget = makeBudget();
  const result = await advancePremium(asClient(db), asClient(db), PROJECT_ID, {
    budget: budget.api,
    provider: new MockProvider(),
  });

  assert.equal(result.success, true);
  assert.equal(result.data?.shotId, 'shot-1');
  const asset = db.tables.media_assets[0];
  assert.equal(asset.shot_id, 'shot-1');
  assert.equal(asset.type, 'video');
  assert.equal(asset.provider, 'mock');
});

test('prémium: a MOCK eredmény látható MOCK / TESZT jelölést kap', async () => {
  const db = setupDb({ withLocation: false, referenceReady: true });
  const budget = makeBudget();
  await advancePremium(asClient(db), asClient(db), PROJECT_ID, {
    budget: budget.api,
    provider: new MockProvider(),
  });

  const asset = db.tables.media_assets[0];
  assert.equal(asset.source_label, 'mock');
  assert.ok(String(asset.attribution).includes('MOCK / TESZT'));
  assert.equal(asset.attribution, MOCK_LABEL);
});

// ---------------------------------------------------------------------------
// C) A videó csak ellenőrzés és sikeres feltöltés után "ready"
// ---------------------------------------------------------------------------

test('prémium: a videó csak sikeres feltöltés után lesz clip_ready', async () => {
  const db = setupDb({ withLocation: false, referenceReady: true });
  const budget = makeBudget();
  await advancePremium(asClient(db), asClient(db), PROJECT_ID, {
    budget: budget.api,
    provider: new MockProvider(),
  });

  const shot = db.tables.shots.find((s) => s.id === 'shot-1');
  assert.equal(shot?.status, 'clip_ready');
  assert.ok(db.uploads.some((path) => path.includes('/shot-1/')));
  assert.equal(db.tables.timeline_items.length, 1);
});

// ---------------------------------------------------------------------------
// C1) Idővonal-összefűzés: a felvételek film sorrendben, egymás után követik
// ---------------------------------------------------------------------------

test('idővonal: a felvételek egymás után fűződnek össze (start_seconds halmozódik)', async () => {
  const db = setupDb({ withLocation: false, referenceReady: true, shotCount: 3 });
  // Az első felvétel hossza 4 mp, a másodiké 6 mp, a harmadiké 5 mp.
  const durations = [4, 6, 5];
  db.tables.shots.forEach((shot, index) => {
    shot.actual_duration_sec = durations[index];
    shot.target_duration_sec = durations[index];
  });

  const budget = makeBudget();
  // A prémium folyamat egy hívásban egy felvételt készít el.
  await advancePremium(asClient(db), asClient(db), PROJECT_ID, {
    budget: budget.api,
    provider: new MockProvider(),
  });
  await advancePremium(asClient(db), asClient(db), PROJECT_ID, {
    budget: budget.api,
    provider: new MockProvider(),
  });
  await advancePremium(asClient(db), asClient(db), PROJECT_ID, {
    budget: budget.api,
    provider: new MockProvider(),
  });

  const video = db.tables.timeline_items.filter((t) => t.track === 'video');
  assert.equal(video.length, 3);

  const byShot = new Map(video.map((item) => [String(item.shot_id), item]));
  const first = byShot.get('shot-1')!;
  const second = byShot.get('shot-2')!;
  const third = byShot.get('shot-3')!;

  // A kezdőidők a korábbi felvételek hosszának összegéből állnak.
  assert.equal(first.start_seconds, 0);
  assert.equal(second.start_seconds, 4);
  assert.equal(third.start_seconds, 10);
  // A hossz és a sorrend is megfelelő.
  assert.equal(first.duration_seconds, 4);
  assert.equal(second.duration_seconds, 6);
  assert.equal(third.duration_seconds, 5);
  assert.equal(first.sequence_order, 1);
  assert.equal(second.sequence_order, 2);
  assert.equal(third.sequence_order, 3);
  // A forrásszakasz is a teljes felvételre mutat.
  assert.equal(second.source_in, 0);
  assert.equal(second.source_out, 6);
});

test('idővonal: újrafeldolgozáskor a kezdőidő és a hossz is frissül', async () => {
  const db = setupDb({ withLocation: false, referenceReady: true, shotCount: 2 });
  const budget = makeBudget();
  await advancePremium(asClient(db), asClient(db), PROJECT_ID, {
    budget: budget.api,
    provider: new MockProvider(),
  });
  await advancePremium(asClient(db), asClient(db), PROJECT_ID, {
    budget: budget.api,
    provider: new MockProvider(),
  });

  const second = db.tables.timeline_items.find((t) => t.shot_id === 'shot-2')!;
  assert.equal(second.start_seconds, 4);

  // Az első felvétel meghosszabbodik: a második kezdőidőjének is el kell csúsznia.
  const first = db.tables.shots.find((s) => s.id === 'shot-1')!;
  first.actual_duration_sec = 10;
  first.target_duration_sec = 10;

  const orderedShots = db.tables.shots.map((shot) => ({
    id: String(shot.id),
    actual_duration_sec: shot.actual_duration_sec as number,
    target_duration_sec: shot.target_duration_sec as number,
  }));
  const linked = await linkTimelineItem(
    asClient(db),
    PROJECT_ID,
    'shot-2',
    String(second.media_asset_id),
    orderedShots,
    orderedShots[1]
  );
  assert.ok(linked.ok);

  const updated = db.tables.timeline_items.find((t) => t.shot_id === 'shot-2')!;
  assert.equal(updated.start_seconds, 10);
  assert.equal(updated.duration_seconds, 4);
  assert.equal(updated.sequence_order, 2);
});

// ---------------------------------------------------------------------------
// C2) Multi-reference: az `elements` tömb a további referenciákkal
// ---------------------------------------------------------------------------

test('prémium: több főszereplőnél az `elements` tömbbe kerülnek a további referenciák', async () => {
  const db = setupDb({ withLocation: false, referenceReady: true });
  // A második főszereplő és a hozzá tartozó jóváhagyott referencia.
  db.tables.characters.push({
    id: 'char-2',
    project_id: PROJECT_ID,
    name: 'Bela',
    canonical_description: 'tall, glasses, blue shirt',
  });
  db.tables.reference_versions.push({
    id: 'ref-2',
    project_id: PROJECT_ID,
    owner_type: 'character',
    owner_id: 'char-2',
    version: 1,
    storage_path: `${PROJECT_ID}/references/character-char-2-ref-2.png`,
    status: 'approved',
  });
  const shot = db.tables.shots.find((s) => s.id === 'shot-1');
  assert.ok(shot);
  shot.featured_character_ids = ['char-1', 'char-2'];

  const budget = makeBudget();
  const provider = new PaidLikeProvider();
  const result = await advancePremium(asClient(db), asClient(db), PROJECT_ID, {
    budget: budget.api,
    provider,
  });

  assert.equal(result.success, true);
  assert.equal(result.data?.phase, 'video');
  // A második főszereplő referencia az `elements` tömbben megy.
  assert.equal(provider.videoElements.length, 1);
  assert.equal(provider.videoElements[0].length, 1);
  assert.ok(
    String(provider.videoElements[0][0].frontalImageUrl).includes('character-char-2-ref-2.png')
  );
  // A promptban @Element1 hivatkozás szerepel.
  assert.ok(provider.videoPrompts[0].includes('@Element1'));
});

test('prémium: egyetlen főszereplőnél az `elements` tömb üres marad', async () => {
  const db = setupDb({ withLocation: false, referenceReady: true });
  const budget = makeBudget();
  const provider = new PaidLikeProvider();
  await advancePremium(asClient(db), asClient(db), PROJECT_ID, {
    budget: budget.api,
    provider,
  });

  assert.equal(provider.videoElements.length, 1);
  assert.equal(provider.videoElements[0].length, 0);
  assert.ok(!provider.videoPrompts[0].includes('@Element'));
});

test('prémium: a helyszín is az `elements` tömbbe kerül, ha van főszereplő', async () => {
  const db = setupDb({ referenceReady: true });
  db.tables.reference_versions.push({
    id: 'ref-loc-1',
    project_id: PROJECT_ID,
    owner_type: 'location',
    owner_id: 'loc-1',
    version: 1,
    storage_path: `${PROJECT_ID}/references/location-loc-1-ref-1.png`,
    status: 'approved',
  });

  const budget = makeBudget();
  const provider = new PaidLikeProvider();
  await advancePremium(asClient(db), asClient(db), PROJECT_ID, {
    budget: budget.api,
    provider,
  });

  assert.equal(provider.videoElements.length, 1);
  assert.equal(provider.videoElements[0].length, 1);
  assert.ok(
    String(provider.videoElements[0][0].frontalImageUrl).includes('location-loc-1-ref-1.png')
  );
  assert.ok(provider.videoPrompts[0].includes('@Element1'));
});

test('prémium: a hibás videó nem lesz kész, és Stock helyettesítő ajánlható', async () => {
  const db = setupDb({ withLocation: false, referenceReady: true });
  const budget = makeBudget();
  // A provider "sikeres", de a fájl nem MP4 -> az ellenőrzés elutasítja.
  const badProvider: PremiumProvider = {
    id: 'mock',
    sourceLabel: 'mock',
    simulated: true,
    submitReferenceImage: async () => ({ ok: true, providerJobId: 'mock-ref' }),
    submitVideo: async () => ({ ok: true, providerJobId: 'mock-vid' }),
    submitLipsync: async () => ({ ok: true, providerJobId: 'mock-lip' }),
    poll: async (step) =>
      step === 'video'
        ? {
            status: 'succeeded',
            outputBytes: new Uint8Array([1, 2, 3, 4]),
            outputContentType: 'video/mp4',
          }
        : { status: 'succeeded', outputBytes: new Uint8Array([1]), outputContentType: 'image/png' },
  };

  const result = await advancePremium(asClient(db), asClient(db), PROJECT_ID, {
    budget: budget.api,
    provider: badProvider,
  });

  assert.equal(result.success, false);
  assert.equal(result.data?.stockFallbackAvailable, true);
  assert.equal(db.tables.media_assets.length, 0);
  const shot = db.tables.shots.find((s) => s.id === 'shot-1');
  assert.equal(shot?.status, 'needs_review');
});

// ---------------------------------------------------------------------------
// D) Bizonytalan kimenet: NEM indul új fizetős kérés
// ---------------------------------------------------------------------------

test('prémium: bizonytalan kimenetnél nem indul új fizetős kérés', async () => {
  const db = setupDb({ withLocation: false });
  const budget = makeBudget();
  // Nem szimulált provider -> a valós árral számol, ezért van foglalás.
  const provider = new PaidLikeProvider({ outcomes: { reference_image: 'uncertain' } });

  const result = await advancePremium(asClient(db), asClient(db), PROJECT_ID, {
    budget: budget.api,
    provider,
  });

  assert.equal(result.success, false);
  assert.equal(result.data?.uncertain, true);
  const job = db.tables.generation_jobs[0];
  assert.equal(job.status, 'uncertain');
  // A foglalás BENT marad (nem szabadul fel, nem is teljesül ki).
  assert.equal(budget.calls.filter((c) => c.kind === 'release').length, 0);
  assert.equal(budget.calls.filter((c) => c.kind === 'settle').length, 0);
  assert.equal(budget.calls.filter((c) => c.kind === 'reserve').length, 1);
  // A provider feladatazonosító elmentődött, hogy csak lekérdezni lehessen.
  assert.equal(job.provider_job_id, 'paid-ref-1');
});

test('prémium: a bizonytalan feladat a következő advance()-ben csak lekérdezésre kerül', async () => {
  const db = setupDb({ withLocation: false });
  const budget = makeBudget();
  const provider = new PaidLikeProvider({ outcomes: { reference_image: 'uncertain' } });

  await advancePremium(asClient(db), asClient(db), PROJECT_ID, {
    budget: budget.api,
    provider,
  });
  assert.equal(db.tables.generation_jobs[0].status, 'uncertain');

  // A következő lépés: a bizonytalan feladatot LEKÉRDEZI (nem indít új kérést).
  const polling = new PaidLikeProvider();
  const result = await advancePremium(asClient(db), asClient(db), PROJECT_ID, {
    budget: budget.api,
    provider: polling,
  });

  // A lekérdezés sikeres lett -> a feladat lezárul, új feladat nem jött létre.
  assert.equal(db.tables.generation_jobs[0].status, 'succeeded');
  assert.equal(db.tables.generation_jobs.length, 1);
  assert.equal(polling.submits.length, 0);
  assert.equal(db.tables.reference_versions.length, 1);
  assert.ok(result.message.length > 0);
});

test('prémium: azonosító nélküli bizonytalan feladat lezáródik, és nem indul új fizetős kérés', async () => {
  const db = setupDb({ withLocation: false });
  const budget = makeBudget();
  const provider = new PaidLikeProvider({
    outcomes: { reference_image: 'uncertain' },
    uncertainWithoutJobId: true,
  });

  await advancePremium(asClient(db), asClient(db), PROJECT_ID, {
    budget: budget.api,
    provider,
  });
  assert.equal(db.tables.generation_jobs[0].status, 'uncertain');
  assert.equal(db.tables.generation_jobs[0].provider_job_id, undefined);

  // A következő lépés: nincs mit lekérdezni -> a feladat lezáródik,
  // a foglalás visszajár, és NEM indul új fizetős kérés.
  const next = new PaidLikeProvider();
  const result = await advancePremium(asClient(db), asClient(db), PROJECT_ID, {
    budget: budget.api,
    provider: next,
  });

  assert.equal(db.tables.generation_jobs[0].status, 'failed');
  assert.equal(db.tables.generation_jobs.length, 1);
  assert.equal(next.submits.length, 0);
  // A foglalás visszajött.
  assert.equal(budget.calls.filter((c) => c.kind === 'release').length, 1);
  // Automatikus újrapróbálás nincs: manuális kérés kell.
  assert.ok(result.message.includes('manuálisan'));
});

test('prémium: a bizonytalan videó feladat sem indít új fizetős kérést', async () => {
  const db = setupDb({ withLocation: false, referenceReady: true });
  const budget = makeBudget();
  const provider = new PaidLikeProvider({ outcomes: { video: 'uncertain' } });

  const result = await advancePremium(asClient(db), asClient(db), PROJECT_ID, {
    budget: budget.api,
    provider,
  });

  assert.equal(result.success, false);
  assert.equal(result.data?.uncertain, true);
  const videoJob = db.tables.generation_jobs.find((j) => j.step === 'video');
  assert.equal(videoJob?.status, 'uncertain');
  assert.equal(budget.calls.filter((c) => c.kind === 'reserve').length, 1);
  // A foglalás bent marad, és a provider feladatazonosító elmentődött.
  assert.equal(budget.calls.filter((c) => c.kind === 'release').length, 0);
  assert.equal(videoJob?.provider_job_id, 'paid-video-1');
});

// ---------------------------------------------------------------------------
// E) Költségvetési ellenőrzés minden fizetős lépés előtt
// ---------------------------------------------------------------------------

test('prémium: a költségvetési foglalás sikertelensége megállítja a fizetős lépést', async () => {
  const db = setupDb({ withLocation: false });
  const budget = makeBudget({ allow: false, reason: 'nincs elég keret' });
  const provider = new PaidLikeProvider();
  const result = await advancePremium(asClient(db), asClient(db), PROJECT_ID, {
    budget: budget.api,
    provider,
  });

  assert.equal(result.success, false);
  assert.equal(result.data?.budgetBlocked, true);
  assert.ok(result.message.includes('nincs elég keret'));
  // A provider NEM lett meghívva (nincs provider_job_id).
  assert.equal(provider.submits.length, 0);
  const job = db.tables.generation_jobs[0];
  assert.equal(job.status, 'failed');
  assert.equal(job.provider_job_id, undefined);
});

test('prémium: a MOCK provider költsége 0, így nem kell foglalás', async () => {
  const db = setupDb({ withLocation: false });
  const budget = makeBudget();
  await advancePremium(asClient(db), asClient(db), PROJECT_ID, {
    budget: budget.api,
    provider: new MockProvider(),
  });
  assert.equal(budget.calls.filter((c) => c.kind === 'reserve').length, 0);
});

// ---------------------------------------------------------------------------
// F) Egy próbálkozás: nincs automatikus újrapróbálás
// ---------------------------------------------------------------------------

test('prémium: sikertelen videó után nincs automatikus újrapróbálás', async () => {
  const db = setupDb({ withLocation: false, referenceReady: true });
  const budget = makeBudget();
  const failing = new MockProvider({ outcomes: { video: 'failed' } });

  const first = await advancePremium(asClient(db), asClient(db), PROJECT_ID, {
    budget: budget.api,
    provider: failing,
  });
  assert.equal(first.success, false);
  const videoJobsAfterFirst = db.tables.generation_jobs.filter((j) => j.step === 'video').length;
  assert.equal(videoJobsAfterFirst, 1);

  // A következő advance() nem indít új videó kérést.
  const second = await advancePremium(asClient(db), asClient(db), PROJECT_ID, {
    budget: budget.api,
    provider: new MockProvider(),
  });
  assert.equal(second.success, false);
  assert.ok(second.message.includes('manuálisan'));
  assert.equal(db.tables.generation_jobs.filter((j) => j.step === 'video').length, 1);
});

test('prémium: manuális újrapróbálás egy új feladatot indít', async () => {
  const db = setupDb({ withLocation: false, referenceReady: true });
  const budget = makeBudget();
  const failing = new MockProvider({ outcomes: { video: 'failed' } });

  await advancePremium(asClient(db), asClient(db), PROJECT_ID, {
    budget: budget.api,
    provider: failing,
  });
  const retry = await advancePremium(asClient(db), asClient(db), PROJECT_ID, {
    budget: budget.api,
    provider: new MockProvider(),
    manualRetry: true,
  });

  assert.equal(retry.success, true);
  assert.equal(db.tables.generation_jobs.filter((j) => j.step === 'video').length, 2);
});

// ---------------------------------------------------------------------------
// G) Előfeltételek
// ---------------------------------------------------------------------------

test('prémium: jóváhagyás nélkül nem indul semmi', async () => {
  const db = setupDb({ approved: false, withLocation: false });
  const budget = makeBudget();
  const result = await advancePremium(asClient(db), asClient(db), PROJECT_ID, {
    budget: budget.api,
    provider: new MockProvider(),
  });
  assert.equal(result.success, false);
  assert.ok(result.message.includes('jóváhagyva'));
  assert.equal(db.tables.generation_jobs.length, 0);
});

test('prémium: nem prémium módú projekt elutasítva', async () => {
  const db = setupDb({ mode: 'stock', withLocation: false });
  const budget = makeBudget();
  const result = await advancePremium(asClient(db), asClient(db), PROJECT_ID, {
    budget: budget.api,
    provider: new MockProvider(),
  });
  assert.equal(result.success, false);
  assert.ok(result.message.includes('Prémium'));
});

test('prémium: idegen projekt elutasítva', async () => {
  const db = setupDb({ withLocation: false });
  db.userId = 'user-2';
  const budget = makeBudget();
  const result = await advancePremium(asClient(db), asClient(db), PROJECT_ID, {
    budget: budget.api,
    provider: new MockProvider(),
  });
  assert.equal(result.success, false);
  assert.ok(result.message.includes('jogosultság'));
});

// ---------------------------------------------------------------------------
// H) A MOCK fixture-ök valódi, ellenőrizhető fájlok
// ---------------------------------------------------------------------------

test('MOCK fixture: a videó fixture átmegy a letöltés-ellenőrzésen', async () => {
  const provider = new MockProvider();
  const polled = await provider.poll('video', 'mock-video-1');
  assert.equal(polled.status, 'succeeded');
  assert.ok(polled.outputBytes && polled.outputBytes.byteLength > 0);
  const validation = validateDownload(polled.outputBytes ?? null, {
    contentType: polled.outputContentType,
  });
  assert.equal(validation.ok, true);
});

test('MOCK fixture: a referencia kép fixture valódi PNG', async () => {
  const provider = new MockProvider();
  const polled = await provider.poll('reference_image', 'mock-ref-1');
  assert.equal(polled.status, 'succeeded');
  const bytes = polled.outputBytes ?? new Uint8Array();
  assert.ok(bytes.byteLength > 0);
  // PNG aláírás
  assert.equal(bytes[0], 0x89);
  assert.equal(bytes[1], 0x50);
  assert.equal(bytes[2], 0x4e);
  assert.equal(bytes[3], 0x47);
});

test('MOCK provider: a siker, hiba és bizonytalan kimenet is kezelve van', async () => {
  const success = new MockProvider();
  const okSubmit = await success.submitVideo({ prompt: 'p', imageUrl: 'u', durationSec: 5 });
  assert.equal(okSubmit.ok, true);
  assert.ok(okSubmit.providerJobId);

  const failed = new MockProvider({ outcomes: { video: 'failed' } });
  const failSubmit = await failed.submitVideo({ prompt: 'p', imageUrl: 'u', durationSec: 5 });
  assert.equal(failSubmit.ok, false);
  assert.equal(failSubmit.uncertain, undefined);

  const uncertain = new MockProvider({ outcomes: { video: 'uncertain' } });
  const uncertainSubmit = await uncertain.submitVideo({
    prompt: 'p',
    imageUrl: 'u',
    durationSec: 5,
  });
  assert.equal(uncertainSubmit.ok, false);
  assert.equal(uncertainSubmit.uncertain, true);
  assert.ok(uncertainSubmit.providerJobId);
});

test('MOCK provider: a szimulált költség elkülönül a valós költségtől', () => {
  const provider = new MockProvider();
  assert.equal(provider.simulated, true);
  assert.equal(provider.sourceLabel, 'mock');
});
