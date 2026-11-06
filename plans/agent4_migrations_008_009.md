# Agent 4 — Migrációk (008 és 009) indokolása

**Állapot: a migrációk NEM futottak és nem futtatandók automatikusan.**
Csak akkor kell alkalmazni őket, ha a Prémium (fal.ai) / MOCK módot élesben is használjátok.

Ez a dokumentum megmondja, hogy a jelenlegi Agent 4-es kód **melyik oszlopokat és
megszorításokat használja**, és hogy ezek nélkül miért nem működne.

---

## 008 — `supabase/migrations/008_premium_mock_support.sql`

### Miért kell

| # | A migráció része | Melyik kód használja | Miért kell |
|---|---|---|---|
| 1 | `media_assets.source_label` CHECK bővítése a `'mock'` értékkel | [`agent4-premium.ts`](../../src/lib/agents/agent4-premium.ts) (`source_label: provider.sourceLabel`), [`agent4-premium-config.ts`](../../src/lib/agents/agent4-premium-config.ts) (`MOCK_SOURCE_LABEL = 'mock'`) | A 004-es migráció CHECK-je csak `'stock_library' \| 'ai_generated' \| 'user_upload'` értékeket enged. A MOCK provider `'mock'` értéket ír, ezért a beszúrás CHECK-sértés miatt meghiúsulna. A MOCK eredmény így félreérthetetlenül elkülönül a valódi AI-kimenettől. |
| 2 | `shots.dialogue_mode` | [`gemini.ts`](../../src/lib/gemini.ts), [`page.tsx`](../../src/app/page.tsx) | Az Agent 2 a beszédmódot a felvételhez írja. |
| 3 | `shots.speaker_character_id` | [`agent4-premium.ts`](../../src/lib/agents/agent4-premium.ts) (`chooseReferenceForShot`), [`agent4-premium-ui.ts`](../../src/lib/agents/agent4-premium-ui.ts), [`agent3.ts`](../../src/lib/agents/agent3.ts) | A referencia-választás szabálya ("pontosan egy főszereplő, különben a beszélő, különben a helyszín") ezekre az oszlopokra épül. Ezek nélkül a kód nem tudja kiválasztani a megfelelő referenciát. |
| 4 | `shots.featured_character_ids` (uuid[]) | ugyanaz, mint a fenti | A "pontosan egy főszereplő" szabály ezt használja. |
| 5 | `reference_versions.gate_status` / `gate_issues` / `gate_checked_at` | [`agent4-premium.ts`](../../src/lib/agents/agent4-premium.ts) (`gate_status: 'passed'`, `gate_issues: []`, `gate_checked_at`) | A referencia nyilvántartásba vétele ezeket az oszlopokat tölti ki. A 002-es migrációban a `reference_versions.status` csak `'proposed' \| 'approved'` lehetett, külön gate-állapot nem volt. |

### Ellenőrzés

A TypeScript típusok már tartalmazzák ezeket a mezőket
([`types.ts`](../../src/lib/supabase/types.ts)), tehát a kód **a migráció nélküli
adatbázison futásidőben elhasal** (Postgres: `column ... does not exist`).

---

## 009 — `supabase/migrations/009_premium_reference_jobs.sql`

### Miért kell

| # | A migráció része | Melyik kód használja | Miért kell |
|---|---|---|---|
| 1 | `generation_jobs.reference_owner_type` | [`agent4-premium.ts`](../../src/lib/agents/agent4-premium.ts) (a referencia feladat létrehozásakor és a szűrésnél), [`agent4-premium-ui.ts`](../../src/lib/agents/agent4-premium-ui.ts) (`resolveReferenceStatus`) | A referencia kép (karakter / helyszín) nem tartozik egy felvételhez, ezért a `shot_id` nem elég a tulajdonos azonosításához. |
| 2 | `generation_jobs.reference_owner_id` | ugyanaz | Ugyanaz a cél: a karakter vagy helyszín uuid-je. |
| 3 | `generation_jobs_reference_owner_idx` index | a `generation_jobs` lekérdezések | A prémium minden lépésben a projektre szűrt feladatokat tölti be. |
| 4 | `generation_jobs_reference_owner_uq` részleges UNIQUE index | az idempotencia garanciája | A meglévő `UNIQUE (shot_id, provider, step, attempt)` megszorítás **nem védi** a referencia feladatokat, mert a `shot_id` NULL, és Postgres a NULL-okat különbözőnek tekinti. Ez a részleges index egy projekten belül egy (tulajdonos, lépés, próbálkozás) kombinációt csak egyszer enged meg. |

### Ellenőrzés

A kód a `reference_owner_type` / `reference_owner_id` mezőket írja és olvassa
([`agent4-premium.ts`](../../src/lib/agents/agent4-premium.ts)), és a
[`types.ts`](../../src/lib/supabase/types.ts) is tartalmazza őket.

---

## Összefoglaló

| Migráció | Kell a jelenlegi kódhoz? | Futtatva van? |
|---|---|---|
| 008 — Prémium/MOCK támogatás | **Igen** — a `source_label = 'mock'`, a `shots.speaker_character_id`, `shots.featured_character_ids` és a `reference_versions.gate_*` oszlopok nélkül a prémium folyamat nem írhat adatot. | **Nem** |
| 009 — Prémium referencia feladatok | **Igen** — a `reference_owner_type` / `reference_owner_id` oszlopok és a részleges UNIQUE index nélkül a referencia feladatok nem nyomon követhetők és az idempotencia nem garantált. | **Nem** |

Mindkét migráció **additív** (csak új nullable oszlopokat, új indexeket és egy
bővített CHECK-megszorítást ad), ezért a régi sorok és a Stock mód változatlanul
működnek. Alkalmazásuk előtt érdemes egy mentést készíteni.

**Új migráció nem készült és nem szükséges** a jelenlegi Agent 4-es kódhoz:
a prémium folyamat a meglévő `generation_jobs`, `media_assets`,
`reference_versions` és `shots` oszlopokat használja, a fenti két migráció
bővítéseivel együtt.
