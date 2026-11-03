-- 004: állapotértékek és háromlépcsős minőségellenőrzés
-- Figyelem: az új enum-értékek ugyanabban a tranzakcióban nem használhatók,
-- ezért ezt a fájlt önmagában kell futtatni.

-- a) Új értékek a meglévő listákhoz
ALTER TYPE public.job_status ADD VALUE IF NOT EXISTS 'uncertain';
ALTER TYPE public.generation_step ADD VALUE IF NOT EXISTS 'planning';
ALTER TYPE public.generation_step ADD VALUE IF NOT EXISTS 'render';

-- b) Három különálló készültségi állapot a felvételeknél
ALTER TABLE public.shots
  ADD COLUMN IF NOT EXISTS qc_technical text NOT NULL DEFAULT 'pending'
    CHECK (qc_technical IN ('pending','ok','failed'));

ALTER TABLE public.shots
  ADD COLUMN IF NOT EXISTS qc_content text NOT NULL DEFAULT 'pending'
    CHECK (qc_content IN ('pending','reviewed','rejected'));

ALTER TABLE public.shots
  ADD COLUMN IF NOT EXISTS scene_accepted boolean NOT NULL DEFAULT false;

-- c) Az anyag eredete (nincs alapértelmezett állítás)
ALTER TABLE public.media_assets
  ADD COLUMN IF NOT EXISTS source_label text
    CHECK (source_label IN ('stock_library','ai_generated','user_upload'));
