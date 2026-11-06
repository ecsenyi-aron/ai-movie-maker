-- AI Movie Maker — 008. Migráció: Prémium/Mock támogatás (additív, visszafelé kompatibilis)
--
-- FONTOS: ezt a migrációt NEM futtattuk és nem futtatjuk automatikusan.
-- Csak akkor kell alkalmazni, ha a Prémium (fal.ai) / Mock módot élesben is használjátok.
--
-- Miért kell:
-- 1. `media_assets.source_label` CHECK értékei (004-es migráció) csak
--    'stock_library' | 'ai_generated' | 'user_upload' — a MOCK provider kimenete
--    külön, félreérthetetlen jelölést ('mock') kap.
-- 2. A felvételekhez nincs beszélő- és szereplőkapcsolat a séma szerint, pedig
--    a lip-sync előfeltétele ("pontosan egy beszélő") és a referencia-választás
--    ("pontosan egy főszereplő") ezt igényli. A kapcsolat mostantól a shot-on van.
-- 3. A referencia gate (Task 3) eredményének tárolási helye: a reference_versions
--    státusza eddig csak 'proposed' | 'approved' lehetett, külön gate állapot kell.
--
-- Minden változtatás additív és nullable: a régi sorok és a régi kód egyaránt
-- működnek tovább. A régi, szabad szöveges kameraszög/kameramozgás értékeket
-- NEM írjuk át — a normalizálás kódban történik.

-- ---------------------------------------------------------------------------
-- 1. media_assets.source_label: 'mock' érték hozzáadása
-- ---------------------------------------------------------------------------
ALTER TABLE public.media_assets
  DROP CONSTRAINT IF EXISTS media_assets_source_label_check;

ALTER TABLE public.media_assets
  ADD CONSTRAINT media_assets_source_label_check
  CHECK (source_label IN ('stock_library', 'ai_generated', 'user_upload', 'mock'));

-- ---------------------------------------------------------------------------
-- 2. shots: beszédmód, beszélő és megjelenő szereplők
-- ---------------------------------------------------------------------------
ALTER TABLE public.shots
  ADD COLUMN IF NOT EXISTS dialogue_mode text
  CHECK (dialogue_mode IS NULL OR dialogue_mode IN ('on_camera', 'voice_over', 'none'));

ALTER TABLE public.shots
  ADD COLUMN IF NOT EXISTS speaker_character_id uuid
  REFERENCES public.characters(id) ON DELETE SET NULL;

ALTER TABLE public.shots
  ADD COLUMN IF NOT EXISTS featured_character_ids uuid[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS shots_speaker_character_id_idx
  ON public.shots (speaker_character_id);

-- ---------------------------------------------------------------------------
-- 3. reference_versions: a referencia gate eredménye
-- ---------------------------------------------------------------------------
ALTER TABLE public.reference_versions
  ADD COLUMN IF NOT EXISTS gate_status text NOT NULL DEFAULT 'unchecked'
  CHECK (gate_status IN ('unchecked', 'passed', 'failed', 'unavailable'));

ALTER TABLE public.reference_versions
  ADD COLUMN IF NOT EXISTS gate_issues text[] NOT NULL DEFAULT '{}';

ALTER TABLE public.reference_versions
  ADD COLUMN IF NOT EXISTS gate_checked_at timestamptz;
