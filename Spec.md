Build a streamlined, Hungarian-language AI filmmaking MVP in Lovable for fast local testing and zero-cost prototyping.

The app is an AI-assisted studio where 5 specialized agents run as steps of ONE orchestrated workflow. They turn a simple film idea into a production plan, a screenplay and shot list, Hungarian speech, video clips and a browser preview. The default output is an **animatic / storyboard preview**, not a finished AI film. Label it "Animatic / előnézet" everywhere in the UI.


1. Rules

- Inspect the existing Lovable project first; reuse working UI, schema and features. Do not rebuild unnecessarily.
- Keep the MVP simple and browser-native. Use Lovable Cloud/Supabase for database, storage and short Edge Functions. No external Docker workers.
- Only Agents 1–2 use Gemini LLM calls. Agents 3–5 are ordinary code, not separate AI agents.
- Default mode: Pixabay stock footage, only if its current terms and free limits are verified. Always label it **“Stock videó (AI-generálás nélkül)”**. Premium fal.ai video is optional and requires explicit approval and a server-side budget check.
- Use Gemini TTS for Hungarian dialogue only after verifying access, endpoint, limits and price. If unavailable or over quota, show dialogue as subtitles with estimated duration. Do not use browser Web Speech API.
- Never invent endpoints, capabilities, durations, free credits, terms or prices. Verify every integration before enabling it. Clearly label unconfigured features; never fake successful generation.
- Calculate costs in server code, never with an LLM. Keep API keys in server-side secrets only.
- Persist progress and job state through refresh and browser closure. Never claim an MP4 exists unless it was actually created and stored.

## 2. Architecture and execution
Frontend: React/Tailwind, Hungarian UI: dashboard, project workspace, one approval screen, asset gallery and sequential preview.

Use Lovable Cloud/Supabase (PostgreSQL, Storage, RLS) and short Edge Functions. Reuse existing auth; otherwise use anonymous sign-in if supported. If data separation is unavailable, disclose that test data may be public.

Run one job at a time per project. `advance(project_id)` reads saved state, performs one short step (including checking provider status), saves and returns. Use documented polling or supported schedules/webhooks; never rely on a browser tab or long-running Edge Function. If background continuation is unsupported, pause safely while closed and resume on reopen; disclose this.

Preview clips sequentially in-browser with audio/subtitles. If no reliable assembly service is configured, offer the playlist and **“Sorozat letöltése ZIP-ben”**; do not block the free path.

## 3. Minimal database
Use normalized tables, foreign keys, indexes and RLS:
- `projects`: id, title, premise, genre, budget_usd (approved cap; 0 for stock), mode (`stock`/`premium`), lipsync, status, approved_at, timestamps.
- `screenplays`: id, project_id, content, version, created_at.
- `characters` and `locations`: project_id, stable ID/name, canonical description and continuity attributes.
- `scenes`: project_id, number, title, description, location_id, time.
- `shots`: scene_id, number, camera angle/movement, action, `dialogue_hu`, `visual_prompt_en`, target/actual duration, estimated flag/cost, status, QC notes.
- `generation_jobs`: id, project_id, shot_id, provider, step (`reference_image`/`video`/`lipsync`/`stock`/`tts`), attempt, prompt, provider_job_id, status, estimated/actual cost, error, timestamps. Unique `(shot_id, provider, step, attempt)`.
- `media_assets`: id, project_id, shot_id, type, persistent storage path/URL, duration, provider, attribution, lipsync_applied, created_at.

Shot statuses: `planned → audio_ready → clip_ready → qc_ok` or `needs_review`. Version outputs and persist transitions. Estimate costs using verified server-side prices; label estimates. Temporary provider URLs are never permanent assets.

4. Reliability
- Create/log a `generation_jobs` row before each provider request.
- Prevent duplicate paid submissions with unique constraints, idempotency and disabled buttons. Save `provider_job_id` immediately; after uncertain timeouts, check/reconcile the existing job before resubmitting.
- Before every paid step (reference, video, lip-sync, retry), check server-side that actual spend + reserved pending costs + next estimated cost stays within the approved cap. Track estimated, reserved and actual costs separately without double-counting. Unknown price disables Premium. If over cap, stop and request approval; browser-only checks are insufficient.
- Allow at most one retry per shot, only if safe and within budget; manual retries use the same server check.
- On API failure, log and mark failed; show a Hungarian error. Never switch providers silently. Premium video may fall back for that shot only to **“Stock helyettesítő (AI-generálás nélkül)”**, marked `needs_review`.
- Mark completed only after downloading to Lovable Storage and validating that the file is non-empty, playable and has checked metadata/duration.
- Agents 1–2 use Gemini structured JSON (`responseMimeType: application/json` + schema), validated server-side. Allow one repair for malformed output; invalid output must never trigger paid calls.
- For 429/quota errors, back off and retry once, then explain clearly; never switch providers silently. If Gemini blocks the idea, explain in Hungarian and let the user edit it; do not bypass safety.

5. Five agents and the single approval workflow
Workflow: (1) user enters one idea; (2) Agents 1–2 return plan, screenplay, characters, locations, scenes, shots and English visual prompts (one Gemini call may return distinct JSON sections); (3) Agent 3 creates speech if available and locks durations; (4) one checkpoint shows editable plan/script/assets/shots, audio or subtitles, durations and server cost. User chooses Stock (default) or Premium, sets cap and optional lip-sync, then clicks **“Jóváhagyás és gyártás indítása”**. Save approval/mode/cap; no per-shot approvals. (5) Agent 4 processes shots sequentially within cap; (6) Agent 5 validates and previews.

Edits rerun only affected work and create a version: structure/script edits rerun Agent 2 for affected scenes/shots; dialogue edits rerun Agent 3 for that shot. Recalculate costs. **No paid work before approval.**

Agent 1 — Production Manager (Gemini)
Create a three-act scene structure. Each scene has stable ID, title, setting, time and visual description. Strict JSON includes scene count and `missing_assets_manifest`; no costs (server calculates them). Show a concise Hungarian summary with IDs.

Agent 2 — Screenplay and Visual Design (Gemini)
Write editable Hungarian screenplay with Hungarian dialogue. Give characters stable IDs and canonical face/hair/clothing descriptions; locations stable IDs and lighting, atmosphere, time and key props. Maintain continuity. Split scenes into shots with stable ID, camera angle/movement, action, `dialogue_hu`, continuity-aware `visual_prompt_en`, and duration within verified provider limits. Return valid JSON for screenplay, characters, locations, scenes and shots, no preamble.

Agent 3 — Audio and Timing (code, no LLM)
For dialogue shots, use verified Gemini TTS; store audio, measure actual file duration, set `duration_estimated=false` and `audio_ready`. No-dialogue shots use target duration. If TTS fails/is unavailable, create no fake audio: use Hungarian subtitles, estimate duration from word count, set `duration_estimated=true`, label **“becsült időtartam”**. Lip-sync requires stored audio. Use locked durations downstream.

Agent 4 — Clip generation (code, no LLM)
Keep secrets server-side; process one shot at a time using locked duration.

**Mode A: Free Stock (default, cost 0 only if verified)**
1. Extract 2–4 plain English keywords from `visual_prompt_en`.
2. Search landscape Pixabay videos only after verifying endpoint, limits, terms and attribution.
3. Choose the closest duration; if difference exceeds 2 seconds, mark `needs_review`.
4. Download/store, validate, save attribution and asset record. Mark complete and `clip_ready`; use cost 0 only if verified.

**Mode B: Premium AI (fal.ai, only after approval and budget check)**
1. Verify chosen fal.ai models/endpoints, inputs, durations, pricing, quota and async status flow; never assume free credits.
2. If image reference is required, generate/store it, then automatically start image-to-video after approval—no per-shot approval.
3. Choose nearest supported duration; if shorter than dialogue, mark `needs_review`.
4. If approved and stored dialogue audio exists, run verified lip-sync before final storage. Track reference, video and lip-sync as separate jobs/costs. On lip-sync failure keep playable unsynced video, set `lipsync_applied=false`, `needs_review`, and treat speech as voice-over.
5. Store and validate final file before `clip_ready`. On video failure/timeout, visibly fall back to stock for that shot only, marked `needs_review`.

Agent 5 — Quality control and preview (code, no LLM)
Check asset existence, playability and duration against the lock. Never claim stock continuity. Set `qc_ok` or `needs_review` and explain in `qc_notes`.

Preview `qc_ok` shots sequentially; include `needs_review` only if selected. Play stored audio or show subtitle overlays. Trim longer clips to locked duration; hold the last frame if shorter where supported. Label **“Animatic / előnézet”**. Never claim MP4 unless actually assembled, stored and validated.

6. Build order and tests
1. Inspect/reuse project; set up schema, Storage and auth/RLS.
2. Build Hungarian dashboard with one idea field.
3. Implement real Gemini Agents 1–2 with JSON validation/versioning.
4. Add verified TTS, storage, measured timing and subtitle fallback.
5. Build editable approval checkpoint with costs, mode, cap and lip-sync option.
6. Implement persisted `advance` and Stock search/download/attribution/validation/idempotency.
7. Add QC, preview and ZIP fallback.
8. Only after free mode works, add Premium behind approval/budget checks.

Test refresh/reopen, duplicate clicks, uncertain timeouts, API/quota failures, budget rejection, retry limit, TTS fallback, stored playable media, attribution and visible stock fallback. At completion, report in Hungarian which integrations work, required secrets/setup, verified limits/prices and limitations. Do not claim untested success; prefer free mode.
