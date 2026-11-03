-- AI Movie Maker — 003. Migráció: Atomic Budget Reservation & Ledger Functions
-- Spec.md 3. és 4. szakasz alapján

-- ---------------------------------------------------------------------------
-- 1. Visszatérési típusok (biztonságos, idempotens létrehozás)
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
  v_spent numeric;
  v_open_reserved numeric;
  v_remaining numeric;
  v_existing_reserve numeric;
  result public.reserve_result;
BEGIN
  -- Negatív összeg elutasítása
  IF p_amount_usd < 0 THEN
    result.ok := false;
    result.reason := 'Negative amount not allowed';
    result.remaining := 0;
    RETURN result;
  END IF;

  -- Projekt zárolása (SELECT ... FOR UPDATE)
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

  -- Ellenőrizzük, hogy ehhez a job-hoz van-e már aktív foglalás (idempotencia)
  SELECT COALESCE(SUM(CASE WHEN kind = 'reserve' THEN amount_usd WHEN kind = 'release' THEN -amount_usd ELSE 0 END), 0)
  INTO v_existing_reserve
  FROM public.budget_ledger
  WHERE job_id = p_job_id AND kind IN ('reserve', 'release');

  IF v_existing_reserve > 0 THEN
    -- Már van foglalás ehhez a job-hoz: idempotent siker
    SELECT COALESCE(SUM(amount_usd), 0) INTO v_spent
    FROM public.budget_ledger
    WHERE project_id = p_project_id AND kind = 'actual';

    SELECT COALESCE(SUM(CASE WHEN kind = 'reserve' THEN amount_usd WHEN kind = 'release' THEN -amount_usd ELSE 0 END), 0)
    INTO v_open_reserved
    FROM public.budget_ledger
    WHERE project_id = p_project_id AND kind IN ('reserve', 'release');

    v_remaining := v_project.budget_usd - (v_spent + v_open_reserved);

    result.ok := true;
    result.reason := 'Already reserved (idempotent)';
    result.remaining := v_remaining;
    RETURN result;
  END IF;

  -- Spent kiszámítása ('actual' összesen)
  SELECT COALESCE(SUM(amount_usd), 0) INTO v_spent
  FROM public.budget_ledger
  WHERE project_id = p_project_id AND kind = 'actual';

  -- Open reserved kiszámítása ('reserve' mínusz 'release')
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
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_project_id uuid;
  v_open_res numeric;
BEGIN
  -- Megkeressük a job-ot és a project_id-t
  SELECT project_id INTO v_project_id
  FROM public.generation_jobs
  WHERE id = p_job_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found: %', p_job_id;
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
  -- Jogosultság ellenőrzés (tulajdonos vagy service_role)
  IF auth.uid() IS NOT NULL AND NOT public.is_project_owner(p_project_id) THEN
    RAISE EXCEPTION 'Access denied for project budget summary';
  END IF;

  SELECT budget_usd INTO v_budget
  FROM public.projects
  WHERE id = p_project_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Project not found: %', p_project_id;
  END IF;

  -- Spent: csak 'actual' tételek
  SELECT COALESCE(SUM(amount_usd), 0) INTO v_spent
  FROM public.budget_ledger
  WHERE project_id = p_project_id AND kind = 'actual';

  -- Open reserved: 'reserve' mínusz 'release'
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
-- 6. SECURITY / GRANT BEÁLLÍTások
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.reserve_budget(uuid, uuid, numeric) FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.settle_budget(uuid, numeric) FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.release_budget(uuid) FROM public, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.reserve_budget(uuid, uuid, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_budget(uuid, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_budget(uuid) TO service_role;

REVOKE EXECUTE ON FUNCTION public.project_budget_summary(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.project_budget_summary(uuid) TO authenticated, service_role;
