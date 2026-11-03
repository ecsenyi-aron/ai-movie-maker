-- AI Movie Maker — 003. Migráció: Atomic Budget Reservation & Ledger Functions (Javított verzió)
-- Spec.md 3. és 4. szakasz alapján

-- ---------------------------------------------------------------------------
-- 1. Visszatérési típusok (idempotens létrehozás)
-- ---------------------------------------------------------------------------
DO $$ BEGIN
    CREATE TYPE public.reserve_result AS (
      ok boolean,
      reason text,
      remaining numeric
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE public.budget_summary AS (
      budget_usd numeric,
      spent_usd numeric,
      open_reserved_usd numeric,
      remaining_usd numeric
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ---------------------------------------------------------------------------
-- 1.b Egyedi (unique) indexek az adatbázis-szintű védelemért (duplikáció ellen)
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS budget_ledger_job_id_reserve_idx 
ON public.budget_ledger (job_id) 
WHERE kind = 'reserve';

CREATE UNIQUE INDEX IF NOT EXISTS budget_ledger_job_id_actual_idx 
ON public.budget_ledger (job_id) 
WHERE kind = 'actual';

-- Megjegyzés a job_id NULL értékeiről és kockázatairól:
-- A partial indexek (WHERE kind = 'reserve' és WHERE kind = 'actual') csak a nem-null job_id-val rendelkező sorokat indexelik.
-- Kockázatértékelés: A PostgreSQL-ben a UNIQUE indexek a NULL értékeket különállónak (distinct) tekintik, így ha a job_id NULL 
-- lehetne, a részleges index nem akadályozná meg a több NULL értékű sort. Azonban a reserve és actual ledger tételeknél 
-- a job_id kötelező (job-hoz kötött), így nincs NULL kockázat.

-- ---------------------------------------------------------------------------
-- 2. reserve_budget(p_project_id uuid, p_job_id uuid, p_amount_usd numeric)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reserve_budget(
  p_project_id uuid,
  p_job_id uuid,
  p_amount_usd numeric
)
RETURNS public.reserve_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_project public.projects%ROWTYPE;
  v_job public.generation_jobs%ROWTYPE;
  v_spent numeric;
  v_open_reserved numeric;
  v_remaining numeric;
  v_existing_reserve_count integer;
  result public.reserve_result;
BEGIN
  -- Negatív összeg elutasítása
  IF p_amount_usd < 0 THEN
    result.ok := false;
    result.reason := 'Negative amount not allowed';
    result.remaining := 0;
    RETURN result;
  END IF;

  -- Ellenőrizzük, hogy a job létezik-e, és a project_id megegyezik-e
  SELECT * INTO v_job
  FROM public.generation_jobs
  WHERE id = p_job_id;

  IF NOT FOUND THEN
    result.ok := false;
    result.reason := 'Job not found';
    result.remaining := 0;
    RETURN result;
  END IF;

  IF v_job.project_id <> p_project_id THEN
    result.ok := false;
    result.reason := 'Job project mismatch';
    result.remaining := 0;
    RETURN result;
  END IF;

  -- Projekt zárolása (SELECT ... FOR UPDATE) a race condition elkerülésére
  SELECT * INTO v_project
  FROM public.projects
  WHERE id = p_project_id
  FOR UPDATE;

  IF NOT FOUND THEN
    result.ok := false;
    result.reason := 'Project not found';
    result.remaining := 0;
    RETURN result;
  END IF;

  -- Ha budget_usd 0 és az összeg > 0, elutasítás
  IF v_project.budget_usd = 0 AND p_amount_usd > 0 THEN
    result.ok := false;
    result.reason := 'Budget is zero';
    result.remaining := 0;
    RETURN result;
  END IF;

  -- Szigorú idempotencia: ha BÁRMILYEN 'reserve' sor létezik ehhez a job_id-hoz (akkor is, ha azóta settle/release volt), tiltjuk az újat
  SELECT COUNT(*) INTO v_existing_reserve_count
  FROM public.budget_ledger
  WHERE job_id = p_job_id AND kind = 'reserve';

  IF v_existing_reserve_count > 0 THEN
    SELECT COALESCE(SUM(amount_usd), 0) INTO v_spent
    FROM public.budget_ledger
    WHERE project_id = p_project_id AND kind = 'actual';

    SELECT COALESCE(SUM(CASE WHEN kind = 'reserve' THEN amount_usd WHEN kind = 'release' THEN -amount_usd ELSE 0 END), 0)
    INTO v_open_reserved
    FROM public.budget_ledger
    WHERE project_id = p_project_id AND kind IN ('reserve', 'release');

    v_remaining := v_project.budget_usd - (v_spent + v_open_reserved);

    result.ok := true;
    result.reason := 'Already reserved before (idempotent)';
    result.remaining := v_remaining;
    RETURN result;
  END IF;

  -- Spent kiszámítása ('actual' összesen)
  SELECT COALESCE(SUM(amount_usd), 0) INTO v_spent
  FROM public.budget_ledger
  WHERE project_id = p_project_id AND kind = 'actual';

  -- Open reserved kiszámítása
  SELECT COALESCE(SUM(CASE WHEN kind = 'reserve' THEN amount_usd WHEN kind = 'release' THEN -amount_usd ELSE 0 END), 0)
  INTO v_open_reserved
  FROM public.budget_ledger
  WHERE project_id = p_project_id AND kind IN ('reserve', 'release');

  v_remaining := v_project.budget_usd - (v_spent + v_open_reserved);

  -- Keret ellenőrzése
  IF (v_spent + v_open_reserved + p_amount_usd) > v_project.budget_usd THEN
    result.ok := false;
    result.reason := 'Budget exceeded';
    result.remaining := v_remaining;
    RETURN result;
  END IF;

  -- Foglalás rögzítése a ledgerben
  INSERT INTO public.budget_ledger (project_id, job_id, kind, amount_usd, note)
  VALUES (p_project_id, p_job_id, 'reserve', p_amount_usd, 'Job budget reservation');

  -- generation_jobs.reserved_cost_usd frissítése
  UPDATE public.generation_jobs
  SET reserved_cost_usd = p_amount_usd, updated_at = now()
  WHERE id = p_job_id;

  v_remaining := v_remaining - p_amount_usd;

  result.ok := true;
  result.reason := 'Reserved successfully';
  result.remaining := v_remaining;
  RETURN result;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. settle_budget(p_job_id uuid, p_actual_usd numeric)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.settle_budget(
  p_job_id uuid,
  p_actual_usd numeric
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_project_id uuid;
  v_open_res numeric;
  v_actual_exists boolean;
  v_reserved_cost numeric;
BEGIN
  -- Negatív tényleges költség elutasítása
  IF p_actual_usd < 0 THEN
    RAISE EXCEPTION 'Negative actual amount not allowed: %', p_actual_usd;
  END IF;

  -- Megkeressük a job-ot és a project_id-t
  SELECT project_id, reserved_cost_usd INTO v_project_id, v_reserved_cost
  FROM public.generation_jobs
  WHERE id = p_job_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found: %', p_job_id;
  END IF;

  -- Projekt zárolása (SELECT ... FOR UPDATE) a race condition elkerülésére először
  PERFORM 1 FROM public.projects WHERE id = v_project_id FOR UPDATE;

  -- Idempotencia: ha már létezik 'actual' tétel ehhez a job-hoz, ne szúrjuk be újra
  SELECT EXISTS (
    SELECT 1 FROM public.budget_ledger WHERE job_id = p_job_id AND kind = 'actual'
  ) INTO v_actual_exists;

  IF v_actual_exists THEN
    RETURN 'already_settled';
  END IF;

  -- Kiszámoljuk a job nyitott foglalását
  SELECT COALESCE(SUM(CASE WHEN kind = 'reserve' THEN amount_usd WHEN kind = 'release' THEN -amount_usd ELSE 0 END), 0)
  INTO v_open_res
  FROM public.budget_ledger
  WHERE job_id = p_job_id AND kind IN ('reserve', 'release');

  -- Ha van nyitott foglalás, felszabadítjuk (release)
  IF v_open_res > 0 THEN
    INSERT INTO public.budget_ledger (project_id, job_id, kind, amount_usd, note)
    VALUES (v_project_id, p_job_id, 'release', v_open_res, 'Release reservation on settle');
  END IF;

  -- Tényleges költség (actual) rögzítése
  INSERT INTO public.budget_ledger (project_id, job_id, kind, amount_usd, note)
  VALUES (v_project_id, p_job_id, 'actual', p_actual_usd, 'Actual cost settlement');

  -- generation_jobs frissítése
  UPDATE public.generation_jobs
  SET actual_cost_usd = p_actual_usd, updated_at = now()
  WHERE id = p_job_id;

  -- Ha a tényleges költség meghaladja a rezervációt, jelezzük a hívónak ('cap_exceeded')
  IF p_actual_usd > COALESCE(v_reserved_cost, 0) THEN
    RETURN 'cap_exceeded';
  END IF;

  RETURN 'settled';
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. release_budget(p_job_id uuid)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.release_budget(
  p_job_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_project_id uuid;
  v_open_res numeric;
BEGIN
  SELECT project_id INTO v_project_id
  FROM public.generation_jobs
  WHERE id = p_job_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found: %', p_job_id;
  END IF;

  -- Projekt zárolása (SELECT ... FOR UPDATE) a race condition elkerülésére
  PERFORM 1 FROM public.projects WHERE id = v_project_id FOR UPDATE;

  SELECT COALESCE(SUM(CASE WHEN kind = 'reserve' THEN amount_usd WHEN kind = 'release' THEN -amount_usd ELSE 0 END), 0)
  INTO v_open_res
  FROM public.budget_ledger
  WHERE job_id = p_job_id AND kind IN ('reserve', 'release');

  IF v_open_res > 0 THEN
    INSERT INTO public.budget_ledger (project_id, job_id, kind, amount_usd, note)
    VALUES (v_project_id, p_job_id, 'release', v_open_res, 'Release reservation on failure');
  END IF;

  UPDATE public.generation_jobs
  SET updated_at = now()
  WHERE id = p_job_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. project_budget_summary(p_project_id uuid)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.project_budget_summary(
  p_project_id uuid
)
RETURNS public.budget_summary
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_budget numeric;
  v_spent numeric;
  v_open_reserved numeric;
  v_remaining numeric;
  summary public.budget_summary;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_project_owner(p_project_id) THEN
    RAISE EXCEPTION 'Access denied for project budget summary';
  END IF;

  SELECT budget_usd INTO v_budget
  FROM public.projects
  WHERE id = p_project_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Project not found: %', p_project_id;
  END IF;

  SELECT COALESCE(SUM(amount_usd), 0) INTO v_spent
  FROM public.budget_ledger
  WHERE project_id = p_project_id AND kind = 'actual';

  SELECT COALESCE(SUM(CASE WHEN kind = 'reserve' THEN amount_usd WHEN kind = 'release' THEN -amount_usd ELSE 0 END), 0)
  INTO v_open_reserved
  FROM public.budget_ledger
  WHERE project_id = p_project_id AND kind IN ('reserve', 'release');

  v_remaining := v_budget - (v_spent + v_open_reserved);

  summary.budget_usd := v_budget;
  summary.spent_usd := v_spent;
  summary.open_reserved_usd := v_open_reserved;
  summary.remaining_usd := v_remaining;

  RETURN summary;
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. SECURITY / GRANT BEÁLLÍTÁSOK
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.reserve_budget(uuid, uuid, numeric) FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.settle_budget(uuid, numeric) FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.release_budget(uuid) FROM public, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.reserve_budget(uuid, uuid, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_budget(uuid, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_budget(uuid) TO service_role;

REVOKE EXECUTE ON FUNCTION public.project_budget_summary(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.project_budget_summary(uuid) TO authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 7. TESZT TERV (BEGIN ... ROLLBACK) MAGYAR NYELVEN
-- ---------------------------------------------------------------------------
/*
  Hogyan tesztelhető az adatbázisban (pl. Supabase SQL Editorban tranzakcióként futtatva):

  BEGIN;

  -- 1. Teszt adatok felvétele
  DO $$
  DECLARE
    v_user_id uuid;
  BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
      SELECT id INTO v_user_id FROM auth.users LIMIT 1;
    END IF;
    
    IF v_user_id IS NOT NULL THEN
      INSERT INTO public.projects (id, user_id, title, budget_usd) 
      VALUES ('11111111-1111-1111-1111-111111111111', v_user_id, 'Teszt Projekt', 100.00);

      INSERT INTO public.generation_jobs (id, project_id, status, step, provider) 
      VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'pending', 'video', 'fal');
    END IF;
  END $$;

  -- 2. Teszt: reserve_budget sikeres futtatás
  SELECT public.reserve_budget('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 10.00);
  -- Elvárt eredmény: ok = true, remaining = 90.00

  -- 3. Teszt: reserve_budget újra ugyanarra a job-ra
  SELECT public.reserve_budget('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 10.00);
  -- Elvárt eredmény: ok = true, reason = 'Already reserved before (idempotent)'

  -- 4. Teszt: settle_budget kétszer hívva
  SELECT public.settle_budget('22222222-2222-2222-2222-222222222222', 12.00);
  -- Első hívás: 'cap_exceeded' (mivel 12.00 > 10.00)
  SELECT public.settle_budget('22222222-2222-2222-2222-222222222222', 12.00);
  -- Második hívás: 'already_settled' (nincs duplázás)

  -- 5. Teszt: Más projekthez tartozó job elutasítása
  DO $$
  DECLARE
    v_user_id uuid;
  BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
      SELECT id INTO v_user_id FROM auth.users LIMIT 1;
    END IF;
    
    IF v_user_id IS NOT NULL THEN
      INSERT INTO public.projects (id, user_id, title, budget_usd) 
      VALUES ('33333333-3333-3333-3333-333333333333', v_user_id, 'Másik Projekt', 50.00);
      INSERT INTO public.generation_jobs (id, project_id, status, step, provider) 
      VALUES ('44444444-4444-4444-4444-444444444444', '33333333-3333-3333-3333-333333333333', 'pending', 'reference_image', 'fal');
    END IF;
  END $$;

  SELECT public.reserve_budget('11111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444444', 5.00);
  -- Elvárt eredmény: ok = false, reason = 'Job project mismatch'

  -- 6. Teszt: Negatív actual költség elutasítása
  DO $$
  DECLARE
    v_user_id uuid;
  BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
      SELECT id INTO v_user_id FROM auth.users LIMIT 1;
    END IF;
    
    IF v_user_id IS NOT NULL THEN
      INSERT INTO public.generation_jobs (id, project_id, status, step, provider) 
      VALUES ('55555555-5555-5555-5555-555555555555', '11111111-1111-1111-1111-111111111111', 'pending', 'video', 'fal');
    END IF;
  END $$;

  SELECT public.reserve_budget('11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555555', 5.00);
  -- SELECT public.settle_budget('55555555-5555-5555-5555-555555555555', -2.00);
  -- Elvárt eredmény: SQL hiba (Negative actual amount not allowed).

  ROLLBACK;
*/
