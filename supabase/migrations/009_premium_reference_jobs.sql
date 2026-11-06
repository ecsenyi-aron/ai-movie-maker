-- AI Movie Maker — 009. Migráció: Prémium referencia feladatok nyomon követése
--
-- Miért kell (additív, nem destruktív):
-- 1. A `generation_jobs` táblában a `shot_id` NULL lehet, de a Prémium
--    referencia képek (karakter / helyszín) NEM tartoznak egy felvételhez.
--    A `UNIQUE (shot_id, provider, step, attempt)` megszorítás ezért nem védi a
--    referencia feladatokat: minden NULL shot_id külön sor lenne.
-- 2. Ez a migráció nullable oszlopokat ad hozzá, és egy részleges UNIQUE
--    indexet hoz létre, hogy egy (projekt, provider, lépés, tulajdonos,
--    próbálkozás) kombináció csak egyszer létezhessen.
-- 3. A `reference_owner_id` a `characters` vagy `locations` tábla uuid-je.
--
-- A migráció NEM futtatja le a `reference_versions` adatokat: csak a séma
-- bővül, minden új oszlop nullable / NOT NULL DEFAULT 'unchecked' értékkel.

ALTER TABLE public.generation_jobs
  ADD COLUMN IF NOT EXISTS reference_owner_type text
  CHECK (reference_owner_type IS NULL OR reference_owner_type IN ('character', 'location'));

ALTER TABLE public.generation_jobs
  ADD COLUMN IF NOT EXISTS reference_owner_id uuid;

CREATE INDEX IF NOT EXISTS generation_jobs_reference_owner_idx
  ON public.generation_jobs (project_id, step, reference_owner_id);

-- Egy referencia tulajdonoshoz, providerhez, lépéshez és próbálkozáshoz
-- csak egy job lehet. A shot_id NULL-os jobokra ez az egyetlen védelem.
CREATE UNIQUE INDEX IF NOT EXISTS generation_jobs_reference_owner_uq
  ON public.generation_jobs (project_id, provider, step, reference_owner_id, attempt)
  WHERE reference_owner_id IS NOT NULL;
