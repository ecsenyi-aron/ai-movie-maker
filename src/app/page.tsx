'use client';

import { useState } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/client';
import { runAgent5QC } from '@/lib/agents/agent5';

export default function HungarianDashboard() {
  const [premise, setPremise] = useState('');
  const [genre, setGenre] = useState('Dráma');
  const [loading, setLoading] = useState(false);
  const [stepStatus, setStepStatus] = useState('');
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');
  const [approvalMode, setApprovalMode] = useState<'stock' | 'premium'>('stock');
  const [budgetCap, setBudgetCap] = useState<number>(0);
  const [lipsync, setLipsync] = useState<boolean>(false);
  const [approving, setApproving] = useState<boolean>(false);
  const [exportZipEnabled, setExportZipEnabled] = useState<boolean>(false);
  const [licenseAccepted, setLicenseAccepted] = useState<boolean>(false);

  const supabase = getSupabaseBrowserClient();

  const handleApprovalAndStartProduction = async () => {
    if (!result?.project?.id) return;
    setApproving(true);
    setError('');

    try {
      const projectId = result.project.id;
      
      // 1. Update project status to approved
      await supabase
        .from('projects')
        .update({
          mode: approvalMode,
          budget_usd: approvalMode === 'premium' ? budgetCap : 0,
          lipsync: lipsync,
          status: 'approved',
          approved_at: new Date().toISOString()
        })
        .eq('id', projectId);

      // 2. Fetch all scenes and shots for this project
      const { data: scenesData } = await supabase
        .from('scenes')
        .select('id, number')
        .eq('project_id', projectId);

      if (scenesData && scenesData.length > 0) {
        for (const sc of scenesData) {
          const { data: shotsData } = await supabase
            .from('shots')
            .select('*')
            .eq('scene_id', sc.id);

          if (shotsData) {
            for (const shot of shotsData) {
              // Run Agent 3: Audio & Timing via API
              const resTts = await fetch('/api/agents', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'tts', dialogueHu: shot.dialogue_hu, targetDuration: shot.target_duration_sec || 4.0 })
              });
              const dataTts = await resTts.json();
              if (!resTts.ok) throw new Error(dataTts.error || 'Hiba az Audio ügynök (TTS) futtatásakor.');
              const ttsRes = dataTts.result;

              // Update shot duration & status
              await supabase
                .from('shots')
                .update({
                  actual_duration_sec: ttsRes.durationSec,
                  duration_estimated: ttsRes.isEstimated,
                  status: 'audio_ready'
                })
                .eq('id', shot.id);

              // Run Agent 4: Clip Generation (Stock) via API
              const resClip = await fetch('/api/agents', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'agent4', visualPromptEn: shot.visual_prompt_en, targetDuration: ttsRes.durationSec })
              });
              const dataClip = await resClip.json();
              if (!resClip.ok) throw new Error(dataClip.error || 'Hiba a Clip ügynök futtatásakor.');
              const clipRes = dataClip.result;

              if (!clipRes.success) {
                await supabase
                  .from('shots')
                  .update({
                    status: 'needs_review',
                    qc_notes: clipRes.error || 'Stock videó lekérése sikertelen.'
                  })
                  .eq('id', shot.id);
                continue;
              }

              // Run Agent 5: QC & validation
              const qcRes = await runAgent5QC(clipRes.durationSec, ttsRes.durationSec, clipRes.success, clipRes.attribution);

              // Save media asset
              if (clipRes.success && clipRes.publicUrl) {
                await supabase.from('media_assets').insert({
                  project_id: projectId,
                  shot_id: shot.id,
                  type: 'video',
                  storage_path: clipRes.storagePath || 'stock/fallback.mp4',
                  public_url: clipRes.publicUrl,
                  duration_sec: clipRes.durationSec,
                  provider: clipRes.provider,
                  attribution: clipRes.attribution
                });
              }

              // Update shot final status
              await supabase
                .from('shots')
                .update({
                  status: qcRes.status === 'qc_ok' ? 'qc_ok' : 'needs_review',
                  qc_notes: qcRes.qcNotes
                })
                .eq('id', shot.id);
            }
          }
        }
      }

      // 3. Set project status to preview_ready
      await supabase
        .from('projects')
        .update({ status: 'preview_ready' })
        .eq('id', projectId);

      alert('Gyártás sikeresen lefutott! Az Animatic / előnézet elkészült.');
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Hiba történt a gyártás során.');
    } finally {
      setApproving(false);
    }
  };

  const handleCreateAndRunAgents = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!premise.trim()) return;

    setLoading(true);
    setError('');
    setResult(null);

    try {
      // 0. Anonymous sign in if needed, or get session
      let { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        setStepStatus('Névtelen bejelentkezés a Supabase-be...');
        const { error: signInError } = await supabase.auth.signInAnonymously();
        if (signInError) throw new Error(`Supabase Auth hiba: ${signInError.message}`);
        const sessionRes = await supabase.auth.getSession();
        session = sessionRes.data.session;
      }

      if (!session) throw new Error('Nem sikerült bejelentkezni a Supabase-be.');

      const userId = session.user.id;

      // 1. Create project in table
      setStepStatus('Projekt mentése az adatbázisba...');
      const { data: project, error: projErr } = await supabase
        .from('projects')
        .insert({
          user_id: userId,
          title: premise.slice(0, 40) + '...',
          premise: premise,
          genre: genre,
          status: 'planning',
          mode: 'stock',
        })
        .select()
        .single();

      if (projErr || !project) {
        throw new Error(`Projektmentési hiba: ${projErr?.message || 'Ismeretlen hiba'}`);
      }

      const projectId = project.id;

      // 2. Run Agent 1: Production Manager via API
      setStepStatus('1. Ügynök futtatása: Gyártási Vezető (Jelenetstruktúra készítése)...');
      const res1 = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'agent1', premise })
      });
      const data1 = await res1.json();
      if (!res1.ok) throw new Error(data1.error || 'Hiba az 1. ügynök futtatásakor.');
      const agent1Data = data1.result;

      // Update project title from Agent 1 if available
      if (agent1Data.title) {
        await supabase
          .from('projects')
          .update({ title: agent1Data.title, genre: agent1Data.genre || genre })
          .eq('id', projectId);
      }

      // Save scenes
      setStepStatus('Jelenetek mentése az adatbázisba...');
      const sceneMap = new Map<number, string>(); // number -> scene id

      for (const sc of agent1Data.scenes) {
        // Create location first if needed
        let locationId = null;
        if (sc.setting) {
          const stableLocId = `loc_${sc.setting.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
          const { data: locData } = await supabase
            .from('locations')
            .select('id')
            .eq('project_id', projectId)
            .eq('stable_id', stableLocId)
            .single();

          if (locData) {
            locationId = locData.id;
          } else {
            const { data: newLoc } = await supabase
              .from('locations')
              .insert({
                project_id: projectId,
                stable_id: stableLocId,
                name: sc.setting,
                canonical_description: sc.setting
              })
              .select('id')
              .single();
            if (newLoc) locationId = newLoc.id;
          }
        }

        const { data: insertedScene, error: scErr } = await supabase
          .from('scenes')
          .insert({
            project_id: projectId,
            number: sc.number,
            title: sc.title,
            description: sc.description,
            time_of_day: sc.time_of_day,
            location_id: locationId
          })
          .select('id')
          .single();

        if (insertedScene) {
          sceneMap.set(sc.number, insertedScene.id);
        }
      }

      // 3. Run Agent 2: Screenplay & Visual Design via API
      setStepStatus('2. Ügynök futtatása: Forgatókönyv & Vizuális Tervezés...');
      const res2 = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'agent2', premise, agent1Result: agent1Data })
      });
      const data2 = await res2.json();
      if (!res2.ok) throw new Error(data2.error || 'Hiba a 2. ügynök futtatásakor.');
      const agent2Data = data2.result;

      // Save screenplay
      await supabase
        .from('screenplays')
        .insert({
          project_id: projectId,
          content: agent2Data.screenplay_text,
          version: 1
        });

      // Save characters
      if (agent2Data.characters) {
        for (const ch of agent2Data.characters) {
          await supabase.from('characters').insert({
            project_id: projectId,
            stable_id: ch.stable_id,
            name: ch.name,
            canonical_description: ch.canonical_description
          });
        }
      }

      // Save shots
      setStepStatus('Felvételek (shots) és promptok mentése...');
      if (agent2Data.shots) {
        for (const sh of agent2Data.shots) {
          const sceneId = sceneMap.get(sh.scene_number);
          if (sceneId) {
            await supabase.from('shots').insert({
              scene_id: sceneId,
              number: sh.number,
              camera_angle: sh.camera_angle,
              camera_movement: sh.camera_movement,
              action: sh.action,
              dialogue_hu: sh.dialogue_hu || '',
              visual_prompt_en: sh.visual_prompt_en,
              target_duration_sec: sh.target_duration_sec || 4.0,
              status: 'planned'
            });
          }
        }
      }

      // Update project status to awaiting_approval
      await supabase
        .from('projects')
        .update({ status: 'awaiting_approval' })
        .eq('id', projectId);

      setStepStatus('Kész! Az ügynökök sikeresen lefutottak.');
      setResult({
        project,
        agent1: agent1Data,
        agent2: agent2Data
      });

    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Hiba történt a generálás során.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-1 justify-center px-6 py-12">
      <main className="flex w-full max-w-2xl flex-col gap-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm uppercase tracking-wide text-zinc-500">
              Animatic / előnézet — Stúdió
            </p>
            <h1 className="text-2xl font-semibold tracking-tight">
              Magyar AI Filmstúdió Vezérlőpult
            </h1>
          </div>
          <a
            href="/setup"
            className="text-xs text-zinc-500 underline hover:text-zinc-800 dark:hover:text-zinc-300"
          >
            Rendszerbeállítások (/setup)
          </a>
        </div>

        <p className="text-zinc-600 dark:text-zinc-400">
          Add meg a filmötleted (premise). Az AI 1. és 2. Ügynöke automatikusan elkészíti a háromfelvonásos jelenetstruktúrát, a forgatókönyvet és a vizuális promptokat.
        </p>

        <form onSubmit={handleCreateAndRunAgents} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium">Film műfaja</label>
            <select
              value={genre}
              onChange={(e) => setGenre(e.target.value)}
              className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            >
              <option value="Dráma">Dráma</option>
              <option value="Sci-Fi">Sci-Fi</option>
              <option value="Thriller">Thriller</option>
              <option value="Vígjáték">Vígjáték</option>
              <option value="Animációs">Animációs</option>
            </select>
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium">Filmötlet (Premise)</label>
            <textarea
              rows={4}
              value={premise}
              onChange={(e) => setPremise(e.target.value)}
              placeholder="Pl.: Egy magányos órás Budapesten olyan órát talál, amivel öt percet visszatekerhet az időben, de minden alkalommal elfelejt valakit, akit szeret."
              className="rounded-md border border-zinc-300 bg-white p-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              required
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="rounded-md bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            {loading ? 'Ügynökök dolgoznak...' : 'Projekt Létrehozása és Ügynökök Indítása'}
          </button>
        </form>

        {loading && (
          <div className="rounded-md border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
            <div className="flex items-center gap-3">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-600 border-t-transparent"></div>
              <span>{stepStatus}</span>
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-400">
            {error}
          </div>
        )}

        {result && (
          <div className="flex flex-col gap-6 rounded-lg border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex items-center justify-between border-b border-zinc-100 pb-4 dark:border-zinc-800">
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                Jóváhagyási Ellenőrzőpont: {result.agent1.title}
              </h2>
              <span className="rounded bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700 dark:bg-amber-950/50 dark:text-amber-400">
                Várakozik jóváhagyásra
              </span>
            </div>

            {/* Approval Controls */}
            <div className="flex flex-col gap-4 rounded-md border border-zinc-100 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-950/50">
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Gyártási paraméterek</h3>
              
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Mód</label>
                  <select
                    value={approvalMode}
                    onChange={(e) => setApprovalMode(e.target.value as 'stock' | 'premium')}
                    className="rounded border border-zinc-300 bg-white px-2.5 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                  >
                    <option value="stock">Stock videó (Ingyenes / Pixabay)</option>
                    <option value="premium">Prémium AI videó (fal.ai - Költségkeret szükséges)</option>
                  </select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Költségkeret cap (USD)</label>
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={budgetCap}
                    onChange={(e) => setBudgetCap(Number(e.target.value))}
                    disabled={approvalMode === 'stock'}
                    className="rounded border border-zinc-300 bg-white px-2.5 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900 disabled:opacity-50"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="lipsync"
                  checked={lipsync}
                  onChange={(e) => setLipsync(e.target.checked)}
                  className="rounded border-zinc-300 dark:border-zinc-700"
                />
                <label htmlFor="lipsync" className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                  Szájmozgás szinkronizáció (Lip-sync) engedélyezése (ha van hang)
                </label>
              </div>

              <button
                onClick={handleApprovalAndStartProduction}
                disabled={approving}
                className="mt-2 rounded bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                {approving ? 'Gyártás folyamatban...' : 'Jóváhagyás és gyártás indítása'}
              </button>
            </div>

            <div>
              <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Jelenetek (1. Ügynök)</h3>
              <ul className="mt-2 flex flex-col gap-2">
                {result.agent1.scenes.map((sc: any) => (
                  <li key={sc.number} className="rounded border border-zinc-100 p-3 text-sm dark:border-zinc-800">
                    <span className="font-semibold">{sc.number}. {sc.title}</span> ({sc.setting}, {sc.time_of_day})
                    <p className="mt-1 text-zinc-600 dark:text-zinc-400">{sc.description}</p>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Forgatókönyv kivonat (2. Ügynök)</h3>
              <pre className="mt-2 max-h-60 overflow-y-auto rounded bg-zinc-50 p-3 text-xs text-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 whitespace-pre-wrap">
                {result.agent2.screenplay_text}
              </pre>
            </div>

            <div>
              <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Felvételek és vizuális promptok ({result.agent2.shots?.length || 0} db shot)</h3>
              <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                Helyettesítő felvétel: a szereplő és a helyszín nem biztosan egyezik.
              </p>
              <div className="mt-2 flex flex-col gap-2 max-h-80 overflow-y-auto">
                {result.agent2.shots?.map((sh: any, idx: number) => (
                  <div key={idx} className="rounded border border-zinc-100 p-3 text-xs dark:border-zinc-800 flex flex-col gap-1">
                    <div className="font-semibold text-zinc-900 dark:text-zinc-100">
                      Jelenet {sh.scene_number} / Shot {sh.number} [{sh.camera_angle} - {sh.camera_movement}]
                    </div>
                    <div><span className="font-medium">Akció:</span> {sh.action}</div>
                    {sh.dialogue_hu && <div><span className="font-medium">Párbeszéd:</span> "{sh.dialogue_hu}"</div>}
                    <div className="text-zinc-500"><span className="font-medium">Prompt (EN):</span> {sh.visual_prompt_en}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Export options */}
            <div className="flex flex-col gap-3 rounded-md border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-950/50">
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Exportálási lehetőségek</h3>
              <p className="text-xs text-zinc-600 dark:text-zinc-400">
                Alapértelmezésben csak a projekt leírása (forgatókönyv, shot lista, attribution listák) exportálható.
              </p>
              
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    const text = `Film: ${result.agent1.title}\nMűfaj: ${result.agent1.genre}\n\nForgatókönyv:\n${result.agent2.screenplay_text}`;
                    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'projekt_leiras.txt';
                    a.click();
                  }}
                  className="rounded bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900"
                >
                  Projekt leírás exportálása (Alapértelmezett)
                </button>
              </div>

              <div className="mt-2 flex flex-col gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
                <label className="flex items-center gap-2 text-xs font-medium text-zinc-700 dark:text-zinc-300">
                  <input
                    type="checkbox"
                    checked={exportZipEnabled}
                    onChange={(e) => setExportZipEnabled(e.target.checked)}
                    className="rounded border-zinc-300"
                  />
                  Nyers stock klip ZIP letöltés engedélyezése (Alapból KI)
                </label>

                {exportZipEnabled && (
                  <div className="flex flex-col gap-2 rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
                    <p className="font-semibold">Licenc figyelmeztetés:</p>
                    <p>A nyers stock klip ZIP letöltéshez kötelezően ellenőrizni kell a külső szerzői jogi feltéteket és licenceket. Harmadik fél tartalmaiért a felelősség a felhasználót terheli.</p>
                    <label className="flex items-center gap-2 font-medium">
                      <input
                        type="checkbox"
                        checked={licenseAccepted}
                        onChange={(e) => setLicenseAccepted(e.target.checked)}
                        className="rounded border-amber-400"
                      />
                      Elfogadom a licenc feltételeket és tisztában vagyok a szerzői jogi felelősséggel
                    </label>
                    <button
                      disabled={!licenseAccepted}
                      onClick={() => alert('ZIP letöltés külső stock csomagoláshoz (licenc elfogadva).')}
                      className="mt-1 rounded bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                    >
                      Nyers Stock Klip ZIP Letöltése
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
