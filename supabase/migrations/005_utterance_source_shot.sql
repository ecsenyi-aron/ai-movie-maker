-- 005: stabil kulcs a beszédhez és védelem a duplikáció ellen
ALTER TABLE public.utterances
  ADD COLUMN IF NOT EXISTS source_shot_id uuid REFERENCES public.shots(id) ON DELETE SET NULL;

UPDATE public.utterances
SET source_shot_id = (voice_settings->>'source_shot_id')::uuid
WHERE source_shot_id IS NULL
  AND voice_settings->>'source_shot_id' IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS utterances_source_shot_version_uq
  ON public.utterances (source_shot_id, version)
  WHERE source_shot_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS timeline_video_per_shot_uq
  ON public.timeline_items (shot_id)
  WHERE track = 'video';

CREATE UNIQUE INDEX IF NOT EXISTS timeline_subtitle_per_utterance_uq
  ON public.timeline_items (utterance_id)
  WHERE track = 'subtitle';
