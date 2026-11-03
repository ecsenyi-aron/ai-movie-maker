-- AI Movie Maker — kezdeti séma, Storage bucket, RLS
-- Biztonságos, többször futtatható (idempotens) verzió.

-- ---------------------------------------------------------------------------
-- Enumok (biztonságos létrehozás hibakezeléssel)
-- ---------------------------------------------------------------------------
DO $$ BEGIN
    CREATE TYPE project_mode AS ENUM ('stock', 'premium');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE public.project_status AS ENUM (
      'draft',
      'planning',
      'awaiting_approval',
      'approved',
      'generating',
      'preview_ready',
      'failed'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE public.shot_status AS ENUM (
      'planned',
      'audio_ready',
      'clip_ready',
      'qc_ok',
      'needs_review'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE public.generation_step AS ENUM (
      'reference_image',
      'video',
      'lipsync',
      'stock',
      'tts'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE public.job_status AS ENUM (
      'pending',
      'submitted',
      'processing',
      'succeeded',
      'failed',
      'cancelled'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE public.media_type AS ENUM (
      'audio',
      'video',
      'image',
      'subtitle'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ---------------------------------------------------------------------------
-- Táblák
-- ---------------------------------------------------------------------------

-- Projektek (egy felhasználó saját filmötletei)
CREATE TABLE IF NOT EXISTS public.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT '',
  premise text NOT NULL DEFAULT '',
  genre text,
  budget_usd numeric(12, 4) NOT NULL DEFAULT 0,
  mode public.project_mode NOT NULL DEFAULT 'stock',
  lipsync boolean NOT NULL DEFAULT false,
  status public.project_status NOT NULL DEFAULT 'draft',
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS projects_user_id_idx ON public.projects (user_id);
CREATE INDEX IF NOT EXISTS projects_status_idx ON public.projects (status);

-- Forgatókönyvek (verziózott)
CREATE TABLE IF NOT EXISTS public.screenplays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects (id) ON DELETE CASCADE,
  content text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, version)
);

CREATE INDEX IF NOT EXISTS screenplays_project_id_idx ON public.screenplays (project_id);

-- Karakterek (stabil ID a kontinuitáshoz)
CREATE TABLE IF NOT EXISTS public.characters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects (id) ON DELETE CASCADE,
  stable_id text NOT NULL,
  name text NOT NULL,
  canonical_description text NOT NULL DEFAULT '',
  continuity jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, stable_id)
);

CREATE INDEX IF NOT EXISTS characters_project_id_idx ON public.characters (project_id);

-- Helyszínek
CREATE TABLE IF NOT EXISTS public.locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects (id) ON DELETE CASCADE,
  stable_id text NOT NULL,
  name text NOT NULL,
  canonical_description text NOT NULL DEFAULT '',
  continuity jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, stable_id)
);

CREATE INDEX IF NOT EXISTS locations_project_id_idx ON public.locations (project_id);

-- Jelenetek
CREATE TABLE IF NOT EXISTS public.scenes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects (id) ON DELETE CASCADE,
  number integer NOT NULL,
  title text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  location_id uuid REFERENCES public.locations (id) ON DELETE SET NULL,
  time_of_day text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, number)
);

CREATE INDEX IF NOT EXISTS scenes_project_id_idx ON public.scenes (project_id);
CREATE INDEX IF NOT EXISTS scenes_location_id_idx ON public.scenes (location_id);

-- Felvételek (shots)
CREATE TABLE IF NOT EXISTS public.shots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scene_id uuid NOT NULL REFERENCES public.scenes (id) ON DELETE CASCADE,
  number integer NOT NULL,
  camera_angle text,
  camera_movement text,
  action text NOT NULL DEFAULT '',
  dialogue_hu text,
  visual_prompt_en text NOT NULL DEFAULT '',
  target_duration_sec numeric(8, 3),
  actual_duration_sec numeric(8, 3),
  duration_estimated boolean NOT NULL DEFAULT true,
  estimated_cost_usd numeric(12, 4) NOT NULL DEFAULT 0,
  actual_cost_usd numeric(12, 4) NOT NULL DEFAULT 0,
  status public.shot_status NOT NULL DEFAULT 'planned',
  qc_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scene_id, number)
);

CREATE INDEX IF NOT EXISTS shots_scene_id_idx ON public.shots (scene_id);
CREATE INDEX IF NOT EXISTS shots_status_idx ON public.shots (status);

-- Generálási feladatok (minden provider-hívás előtt napló)
CREATE TABLE IF NOT EXISTS public.generation_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects (id) ON DELETE CASCADE,
  shot_id uuid REFERENCES public.shots (id) ON DELETE CASCADE,
  provider text NOT NULL,
  step public.generation_step NOT NULL,
  attempt integer NOT NULL DEFAULT 1,
  prompt text,
  provider_job_id text,
  status public.job_status NOT NULL DEFAULT 'pending',
  estimated_cost_usd numeric(12, 4) NOT NULL DEFAULT 0,
  reserved_cost_usd numeric(12, 4) NOT NULL DEFAULT 0,
  actual_cost_usd numeric(12, 4) NOT NULL DEFAULT 0,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shot_id, provider, step, attempt)
);

CREATE INDEX IF NOT EXISTS generation_jobs_project_id_idx ON public.generation_jobs (project_id);
CREATE INDEX IF NOT EXISTS generation_jobs_shot_id_idx ON public.generation_jobs (shot_id);
CREATE INDEX IF NOT EXISTS generation_jobs_status_idx ON public.generation_jobs (status);
CREATE INDEX IF NOT EXISTS generation_jobs_provider_job_id_idx ON public.generation_jobs (provider_job_id);

-- Média fájlok (csak tartós Storage útvonal/URL)
CREATE TABLE IF NOT EXISTS public.media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects (id) ON DELETE CASCADE,
  shot_id uuid REFERENCES public.shots (id) ON DELETE SET NULL,
  type public.media_type NOT NULL,
  storage_path text NOT NULL,
  public_url text,
  duration_sec numeric(8, 3),
  provider text,
  attribution text,
  lipsync_applied boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS media_assets_project_id_idx ON public.media_assets (project_id);
CREATE INDEX IF NOT EXISTS media_assets_shot_id_idx ON public.media_assets (shot_id);

-- updated_at automatikus frissítése
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS projects_set_updated_at ON public.projects;
CREATE TRIGGER projects_set_updated_at
  BEFORE UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS shots_set_updated_at ON public.shots;
CREATE TRIGGER shots_set_updated_at
  BEFORE UPDATE ON public.shots
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS generation_jobs_set_updated_at ON public.generation_jobs;
CREATE TRIGGER generation_jobs_set_updated_at
  BEFORE UPDATE ON public.generation_jobs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Segédfüggvények RLS-hez
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_project_owner(p_project_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.projects
    WHERE id = p_project_id
      AND user_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION public.is_scene_owner(p_scene_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.scenes s
    JOIN public.projects p ON p.id = s.project_id
    WHERE s.id = p_scene_id
      AND p.user_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION public.is_shot_owner(p_shot_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.shots sh
    JOIN public.scenes s ON s.id = sh.scene_id
    JOIN public.projects p ON p.id = s.project_id
    WHERE sh.id = p_shot_id
      AND p.user_id = auth.uid()
  );
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security (RLS) bekapcsolása
-- ---------------------------------------------------------------------------
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.screenplays ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.characters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scenes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.generation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_assets ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- RLS Policy-k (biztonságos újralétrehozás DROP-pal)
-- ---------------------------------------------------------------------------

-- projects
DROP POLICY IF EXISTS projects_select_own ON public.projects;
CREATE POLICY projects_select_own ON public.projects
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS projects_insert_own ON public.projects;
CREATE POLICY projects_insert_own ON public.projects
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS projects_update_own ON public.projects;
CREATE POLICY projects_update_own ON public.projects
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS projects_delete_own ON public.projects;
CREATE POLICY projects_delete_own ON public.projects
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- screenplays
DROP POLICY IF EXISTS screenplays_select_own ON public.screenplays;
CREATE POLICY screenplays_select_own ON public.screenplays
  FOR SELECT TO authenticated
  USING (public.is_project_owner(project_id));

DROP POLICY IF EXISTS screenplays_insert_own ON public.screenplays;
CREATE POLICY screenplays_insert_own ON public.screenplays
  FOR INSERT TO authenticated
  WITH CHECK (public.is_project_owner(project_id));

DROP POLICY IF EXISTS screenplays_update_own ON public.screenplays;
CREATE POLICY screenplays_update_own ON public.screenplays
  FOR UPDATE TO authenticated
  USING (public.is_project_owner(project_id))
  WITH CHECK (public.is_project_owner(project_id));

DROP POLICY IF EXISTS screenplays_delete_own ON public.screenplays;
CREATE POLICY screenplays_delete_own ON public.screenplays
  FOR DELETE TO authenticated
  USING (public.is_project_owner(project_id));

-- characters
DROP POLICY IF EXISTS characters_select_own ON public.characters;
CREATE POLICY characters_select_own ON public.characters
  FOR SELECT TO authenticated
  USING (public.is_project_owner(project_id));

DROP POLICY IF EXISTS characters_insert_own ON public.characters;
CREATE POLICY characters_insert_own ON public.characters
  FOR INSERT TO authenticated
  WITH CHECK (public.is_project_owner(project_id));

DROP POLICY IF EXISTS characters_update_own ON public.characters;
CREATE POLICY characters_update_own ON public.characters
  FOR UPDATE TO authenticated
  USING (public.is_project_owner(project_id))
  WITH CHECK (public.is_project_owner(project_id));

DROP POLICY IF EXISTS characters_delete_own ON public.characters;
CREATE POLICY characters_delete_own ON public.characters
  FOR DELETE TO authenticated
  USING (public.is_project_owner(project_id));

-- locations
DROP POLICY IF EXISTS locations_select_own ON public.locations;
CREATE POLICY locations_select_own ON public.locations
  FOR SELECT TO authenticated
  USING (public.is_project_owner(project_id));

DROP POLICY IF EXISTS locations_insert_own ON public.locations;
CREATE POLICY locations_insert_own ON public.locations
  FOR INSERT TO authenticated
  WITH CHECK (public.is_project_owner(project_id));

DROP POLICY IF EXISTS locations_update_own ON public.locations;
CREATE POLICY locations_update_own ON public.locations
  FOR UPDATE TO authenticated
  USING (public.is_project_owner(project_id))
  WITH CHECK (public.is_project_owner(project_id));

DROP POLICY IF EXISTS locations_delete_own ON public.locations;
CREATE POLICY locations_delete_own ON public.locations
  FOR DELETE TO authenticated
  USING (public.is_project_owner(project_id));

-- scenes
DROP POLICY IF EXISTS scenes_select_own ON public.scenes;
CREATE POLICY scenes_select_own ON public.scenes
  FOR SELECT TO authenticated
  USING (public.is_project_owner(project_id));

DROP POLICY IF EXISTS scenes_insert_own ON public.scenes;
CREATE POLICY scenes_insert_own ON public.scenes
  FOR INSERT TO authenticated
  WITH CHECK (public.is_project_owner(project_id));

DROP POLICY IF EXISTS scenes_update_own ON public.scenes;
CREATE POLICY scenes_update_own ON public.scenes
  FOR UPDATE TO authenticated
  USING (public.is_project_owner(project_id))
  WITH CHECK (public.is_project_owner(project_id));

DROP POLICY IF EXISTS scenes_delete_own ON public.scenes;
CREATE POLICY scenes_delete_own ON public.scenes
  FOR DELETE TO authenticated
  USING (public.is_project_owner(project_id));

-- shots
DROP POLICY IF EXISTS shots_select_own ON public.shots;
CREATE POLICY shots_select_own ON public.shots
  FOR SELECT TO authenticated
  USING (public.is_scene_owner(scene_id));

DROP POLICY IF EXISTS shots_insert_own ON public.shots;
CREATE POLICY shots_insert_own ON public.shots
  FOR INSERT TO authenticated
  WITH CHECK (public.is_scene_owner(scene_id));

DROP POLICY IF EXISTS shots_update_own ON public.shots;
CREATE POLICY shots_update_own ON public.shots
  FOR UPDATE TO authenticated
  USING (public.is_scene_owner(scene_id))
  WITH CHECK (public.is_scene_owner(scene_id));

DROP POLICY IF EXISTS shots_delete_own ON public.shots;
CREATE POLICY shots_delete_own ON public.shots
  FOR DELETE TO authenticated
  USING (public.is_scene_owner(scene_id));

-- generation_jobs
DROP POLICY IF EXISTS generation_jobs_select_own ON public.generation_jobs;
CREATE POLICY generation_jobs_select_own ON public.generation_jobs
  FOR SELECT TO authenticated
  USING (public.is_project_owner(project_id));

DROP POLICY IF EXISTS generation_jobs_insert_own ON public.generation_jobs;
CREATE POLICY generation_jobs_insert_own ON public.generation_jobs
  FOR INSERT TO authenticated
  WITH CHECK (public.is_project_owner(project_id));

DROP POLICY IF EXISTS generation_jobs_update_own ON public.generation_jobs;
CREATE POLICY generation_jobs_update_own ON public.generation_jobs
  FOR UPDATE TO authenticated
  USING (public.is_project_owner(project_id))
  WITH CHECK (public.is_project_owner(project_id));

DROP POLICY IF EXISTS generation_jobs_delete_own ON public.generation_jobs;
CREATE POLICY generation_jobs_delete_own ON public.generation_jobs
  FOR DELETE TO authenticated
  USING (public.is_project_owner(project_id));

-- media_assets
DROP POLICY IF EXISTS media_assets_select_own ON public.media_assets;
CREATE POLICY media_assets_select_own ON public.media_assets
  FOR SELECT TO authenticated
  USING (public.is_project_owner(project_id));

DROP POLICY IF EXISTS media_assets_insert_own ON public.media_assets;
CREATE POLICY media_assets_insert_own ON public.media_assets
  FOR INSERT TO authenticated
  WITH CHECK (public.is_project_owner(project_id));

DROP POLICY IF EXISTS media_assets_update_own ON public.media_assets;
CREATE POLICY media_assets_update_own ON public.media_assets
  FOR UPDATE TO authenticated
  USING (public.is_project_owner(project_id))
  WITH CHECK (public.is_project_owner(project_id));

DROP POLICY IF EXISTS media_assets_delete_own ON public.media_assets;
CREATE POLICY media_assets_delete_own ON public.media_assets
  FOR DELETE TO authenticated
  USING (public.is_project_owner(project_id));

-- ---------------------------------------------------------------------------
-- Storage: privát „media” bucket + RLS
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'media',
  'media',
  false,
  104857600, -- 100 MB / fájl
  ARRAY[
    'audio/mpeg',
    'audio/wav',
    'audio/ogg',
    'audio/webm',
    'video/mp4',
    'video/webm',
    'image/png',
    'image/jpeg',
    'image/webp',
    'text/vtt',
    'application/zip'
  ]
)
ON CONFLICT (id) DO NOTHING;

-- Storage policies (biztonságos újralétrehozás DROP-pal)
DROP POLICY IF EXISTS media_storage_select_own ON storage.objects;
CREATE POLICY media_storage_select_own ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'media'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS media_storage_insert_own ON storage.objects;
CREATE POLICY media_storage_insert_own ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'media'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS media_storage_update_own ON storage.objects;
CREATE POLICY media_storage_update_own ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'media'
    AND (storage.foldername(name))[1] = auth.uid()::text
  )
  WITH CHECK (
    bucket_id = 'media'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS media_storage_delete_own ON storage.objects;
CREATE POLICY media_storage_delete_own ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'media'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );