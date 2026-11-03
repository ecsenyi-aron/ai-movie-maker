-- AI Movie Maker — 002. Migráció: Hiányzó táblák (Spec.md 3. szakasz szerint pontosítva)
-- utterances, timeline_items, reference_versions, shot_states, lipsync_plan, event_markers, budget_ledger

-- Megerősítés: A 001_initial_schema.sql már definiálja a public.is_project_owner(uuid), public.is_shot_owner(uuid) függvényeket és a public.shot_status enumot.

-- ---------------------------------------------------------------------------
-- 1. utterances (Párbeszédek / hang egységek — független a shot-októl, project_id-hez kötve)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.utterances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects (id) ON DELETE CASCADE,
  character_id uuid REFERENCES public.characters (id) ON DELETE SET NULL,
  text_hu text NOT NULL DEFAULT '',
  delivery_style text,
  voice_settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  audio_path text,
  measured_duration_seconds numeric(8, 3),
  duration_estimated boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS utterances_project_id_idx ON public.utterances (project_id);
CREATE INDEX IF NOT EXISTS utterances_character_id_idx ON public.utterances (character_id);

-- ---------------------------------------------------------------------------
-- 2. timeline_items (Idővonal / animatic előnézet sávok és elemek)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.timeline_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects (id) ON DELETE CASCADE,
  track text NOT NULL CHECK (track IN ('video', 'audio', 'subtitle')),
  shot_id uuid REFERENCES public.shots (id) ON DELETE SET NULL,
  media_asset_id uuid REFERENCES public.media_assets (id) ON DELETE SET NULL,
  utterance_id uuid REFERENCES public.utterances (id) ON DELETE SET NULL,
  start_seconds numeric(8, 3) NOT NULL DEFAULT 0,
  source_in numeric(8, 3) NOT NULL DEFAULT 0,
  source_out numeric(8, 3) NOT NULL DEFAULT 0,
  duration_seconds numeric(8, 3) NOT NULL DEFAULT 0,
  trim_reserve_seconds numeric(8, 3) NOT NULL DEFAULT 0,
  sequence_order integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS timeline_items_project_id_idx ON public.timeline_items (project_id);
CREATE INDEX IF NOT EXISTS timeline_items_shot_id_idx ON public.timeline_items (shot_id);
CREATE INDEX IF NOT EXISTS timeline_items_utterance_id_idx ON public.timeline_items (utterance_id);

-- ---------------------------------------------------------------------------
-- 3. reference_versions (Karakter / helyszín vizuális referenciák)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.reference_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects (id) ON DELETE CASCADE,
  owner_type text NOT NULL CHECK (owner_type IN ('character', 'location')),
  owner_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1,
  storage_path text,
  prompt text,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reference_versions_project_id_idx ON public.reference_versions (project_id);
CREATE INDEX IF NOT EXISTS reference_versions_owner_idx ON public.reference_versions (owner_type, owner_id);

-- Legfeljebb egy approved verzió lehet tulajdonosonként:
CREATE UNIQUE INDEX IF NOT EXISTS reference_versions_single_approved_idx 
ON public.reference_versions (owner_type, owner_id) 
WHERE status = 'approved';

-- ---------------------------------------------------------------------------
-- 4. shot_states (Kontinuitás guard / shot állapotok karakterenként és fázisonként)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.shot_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shot_id uuid NOT NULL REFERENCES public.shots (id) ON DELETE CASCADE,
  character_id uuid REFERENCES public.characters (id) ON DELETE SET NULL,
  phase text NOT NULL CHECK (phase IN ('start', 'end')),
  clothing text,
  injuries text,
  props text,
  pose text,
  gaze_direction text,
  spatial_position text,
  reference_version_id uuid REFERENCES public.reference_versions (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shot_states_shot_id_idx ON public.shot_states (shot_id);
CREATE INDEX IF NOT EXISTS shot_states_character_id_idx ON public.shot_states (character_id);

-- ---------------------------------------------------------------------------
-- 5. lipsync_plan (Szájmozgás szinkronizációs terv)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.lipsync_plan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shot_id uuid NOT NULL REFERENCES public.shots (id) ON DELETE CASCADE,
  speaker_character_id uuid REFERENCES public.characters (id) ON DELETE SET NULL,
  mouth_visible boolean NOT NULL DEFAULT true,
  utterance_id uuid REFERENCES public.utterances (id) ON DELETE SET NULL,
  utterance_start_in_clip numeric(8, 3) NOT NULL DEFAULT 0,
  single_face boolean NOT NULL DEFAULT true,
  tool_supports_input boolean,
  decision text NOT NULL DEFAULT 'planned' CHECK (decision IN ('planned', 'skipped', 'needs_review')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lipsync_plan_shot_id_idx ON public.lipsync_plan (shot_id);
CREATE INDEX IF NOT EXISTS lipsync_plan_utterance_id_idx ON public.lipsync_plan (utterance_id);

-- ---------------------------------------------------------------------------
-- 6. event_markers (Időzítési markerek az idővonalon)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.event_markers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects (id) ON DELETE CASCADE,
  timeline_item_id uuid REFERENCES public.timeline_items (id) ON DELETE CASCADE,
  label text NOT NULL DEFAULT '',
  time_seconds numeric(8, 3) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS event_markers_project_id_idx ON public.event_markers (project_id);
CREATE INDEX IF NOT EXISTS event_markers_timeline_item_id_idx ON public.event_markers (timeline_item_id);

-- ---------------------------------------------------------------------------
-- 7. budget_ledger (Költségvetési főkönyv: reserve, actual, release)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.budget_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects (id) ON DELETE CASCADE,
  job_id uuid REFERENCES public.generation_jobs (id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('reserve', 'actual', 'release')),
  amount_usd numeric(12, 4) NOT NULL DEFAULT 0,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS budget_ledger_project_id_idx ON public.budget_ledger (project_id);
CREATE INDEX IF NOT EXISTS budget_ledger_job_id_idx ON public.budget_ledger (job_id);

-- ---------------------------------------------------------------------------
-- RLS bekapcsolása az új táblákra
-- ---------------------------------------------------------------------------
ALTER TABLE public.utterances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.timeline_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reference_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shot_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lipsync_plan ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_markers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.budget_ledger ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- RLS Policy-k (001-es stílus és helper függvények használatával)
-- ---------------------------------------------------------------------------

-- utterances
DROP POLICY IF EXISTS utterances_select_own ON public.utterances;
CREATE POLICY utterances_select_own ON public.utterances FOR SELECT TO authenticated USING (public.is_project_owner(project_id));
DROP POLICY IF EXISTS utterances_insert_own ON public.utterances;
CREATE POLICY utterances_insert_own ON public.utterances FOR INSERT TO authenticated WITH CHECK (public.is_project_owner(project_id));
DROP POLICY IF EXISTS utterances_update_own ON public.utterances;
CREATE POLICY utterances_update_own ON public.utterances FOR UPDATE TO authenticated USING (public.is_project_owner(project_id)) WITH CHECK (public.is_project_owner(project_id));
DROP POLICY IF EXISTS utterances_delete_own ON public.utterances;
CREATE POLICY utterances_delete_own ON public.utterances FOR DELETE TO authenticated USING (public.is_project_owner(project_id));

-- timeline_items
DROP POLICY IF EXISTS timeline_items_select_own ON public.timeline_items;
CREATE POLICY timeline_items_select_own ON public.timeline_items FOR SELECT TO authenticated USING (public.is_project_owner(project_id));
DROP POLICY IF EXISTS timeline_items_insert_own ON public.timeline_items;
CREATE POLICY timeline_items_insert_own ON public.timeline_items FOR INSERT TO authenticated WITH CHECK (public.is_project_owner(project_id));
DROP POLICY IF EXISTS timeline_items_update_own ON public.timeline_items;
CREATE POLICY timeline_items_update_own ON public.timeline_items FOR UPDATE TO authenticated USING (public.is_project_owner(project_id)) WITH CHECK (public.is_project_owner(project_id));
DROP POLICY IF EXISTS timeline_items_delete_own ON public.timeline_items;
CREATE POLICY timeline_items_delete_own ON public.timeline_items FOR DELETE TO authenticated USING (public.is_project_owner(project_id));

-- reference_versions
DROP POLICY IF EXISTS reference_versions_select_own ON public.reference_versions;
CREATE POLICY reference_versions_select_own ON public.reference_versions FOR SELECT TO authenticated USING (public.is_project_owner(project_id));
DROP POLICY IF EXISTS reference_versions_insert_own ON public.reference_versions;
CREATE POLICY reference_versions_insert_own ON public.reference_versions FOR INSERT TO authenticated WITH CHECK (public.is_project_owner(project_id));
DROP POLICY IF EXISTS reference_versions_update_own ON public.reference_versions;
CREATE POLICY reference_versions_update_own ON public.reference_versions FOR UPDATE TO authenticated USING (public.is_project_owner(project_id)) WITH CHECK (public.is_project_owner(project_id));
DROP POLICY IF EXISTS reference_versions_delete_own ON public.reference_versions;
CREATE POLICY reference_versions_delete_own ON public.reference_versions FOR DELETE TO authenticated USING (public.is_project_owner(project_id));

-- shot_states
DROP POLICY IF EXISTS shot_states_select_own ON public.shot_states;
CREATE POLICY shot_states_select_own ON public.shot_states FOR SELECT TO authenticated USING (public.is_shot_owner(shot_id));
DROP POLICY IF EXISTS shot_states_insert_own ON public.shot_states;
CREATE POLICY shot_states_insert_own ON public.shot_states FOR INSERT TO authenticated WITH CHECK (public.is_shot_owner(shot_id));
DROP POLICY IF EXISTS shot_states_update_own ON public.shot_states;
CREATE POLICY shot_states_update_own ON public.shot_states FOR UPDATE TO authenticated USING (public.is_shot_owner(shot_id)) WITH CHECK (public.is_shot_owner(shot_id));
DROP POLICY IF EXISTS shot_states_delete_own ON public.shot_states;
CREATE POLICY shot_states_delete_own ON public.shot_states FOR DELETE TO authenticated USING (public.is_shot_owner(shot_id));

-- lipsync_plan
DROP POLICY IF EXISTS lipsync_plan_select_own ON public.lipsync_plan;
CREATE POLICY lipsync_plan_select_own ON public.lipsync_plan FOR SELECT TO authenticated USING (public.is_shot_owner(shot_id));
DROP POLICY IF EXISTS lipsync_plan_insert_own ON public.lipsync_plan;
CREATE POLICY lipsync_plan_insert_own ON public.lipsync_plan FOR INSERT TO authenticated WITH CHECK (public.is_shot_owner(shot_id));
DROP POLICY IF EXISTS lipsync_plan_update_own ON public.lipsync_plan;
CREATE POLICY lipsync_plan_update_own ON public.lipsync_plan FOR UPDATE TO authenticated USING (public.is_shot_owner(shot_id)) WITH CHECK (public.is_shot_owner(shot_id));
DROP POLICY IF EXISTS lipsync_plan_delete_own ON public.lipsync_plan;
CREATE POLICY lipsync_plan_delete_own ON public.lipsync_plan FOR DELETE TO authenticated USING (public.is_shot_owner(shot_id));

-- event_markers
DROP POLICY IF EXISTS event_markers_select_own ON public.event_markers;
CREATE POLICY event_markers_select_own ON public.event_markers FOR SELECT TO authenticated USING (public.is_project_owner(project_id));
DROP POLICY IF EXISTS event_markers_insert_own ON public.event_markers;
CREATE POLICY event_markers_insert_own ON public.event_markers FOR INSERT TO authenticated WITH CHECK (public.is_project_owner(project_id));
DROP POLICY IF EXISTS event_markers_update_own ON public.event_markers;
CREATE POLICY event_markers_update_own ON public.event_markers FOR UPDATE TO authenticated USING (public.is_project_owner(project_id)) WITH CHECK (public.is_project_owner(project_id));
DROP POLICY IF EXISTS event_markers_delete_own ON public.event_markers;
CREATE POLICY event_markers_delete_own ON public.event_markers FOR DELETE TO authenticated USING (public.is_project_owner(project_id));

-- budget_ledger: CSAK OLVASHATÓ (SELECT) a normál felhasználóknak.
-- Miért? Azért, hogy a kliens oldali kód ne tudja magának jóváírni vagy manipulálni a pénzügyi zárolásokat (reserve/actual/release). 
-- Kizárólag a szerver oldali, védett API / service role jogosult új ledger bejegyzéseket írni.
DROP POLICY IF EXISTS budget_ledger_select_own ON public.budget_ledger;
CREATE POLICY budget_ledger_select_own ON public.budget_ledger
  FOR SELECT TO authenticated
  USING (public.is_project_owner(project_id));
