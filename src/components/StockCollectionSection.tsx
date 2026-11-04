'use client';

import { useCallback, useEffect, useState } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/client';

const AGENT4_LABEL = 'Stock / könyvtári felvétel';
const PAUSE_MS = 1500;

type ShotRow = {
  id: string;
  scene_id: string;
  number: number;
  status: string;
  qc_notes: string | null;
};

type SceneRow = { id: string; number: number };

type AssetRow = {
  id: string;
  shot_id: string | null;
  attribution: string | null;
  duration_sec: number | null;
};

type JobRow = {
  id: string;
  shot_id: string | null;
  status: string;
  error: string | null;
};

type ProjectRow = {
  id: string;
  mode: string;
  status: string;
  approved_at: string | null;
};

function attributionUrl(attribution: string | null): string | null {
  if (!attribution) return null;
  const match = attribution.match(/https?:\/\/\S+/);
  return match ? match[0] : null;
}

export default function StockCollectionSection({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<ProjectRow | null>(null);
  const [shots, setShots] = useState<ShotRow[]>([]);
  const [scenes, setScenes] = useState<SceneRow[]>([]);
  const [assets, setAssets] = useState<AssetRow[]>([]);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [running, setRunning] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [errorText, setErrorText] = useState('');
  const [keyMissing, setKeyMissing] = useState(false);

  const supabase = getSupabaseBrowserClient();

  const load = useCallback(async () => {
    const { data: projectData } = await supabase
      .from('projects')
      .select('id, mode, status, approved_at')
      .eq('id', projectId)
      .maybeSingle();
    setProject((projectData as ProjectRow) ?? null);

    const { data: sceneData } = await supabase
      .from('scenes')
      .select('id, number')
      .eq('project_id', projectId);
    const sceneRows = (sceneData ?? []) as SceneRow[];
    setScenes(sceneRows);

    const sceneIds = sceneRows.map((s) => s.id);
    if (sceneIds.length > 0) {
      const { data: shotData } = await supabase
        .from('shots')
        .select('id, scene_id, number, status, qc_notes')
        .in('scene_id', sceneIds);
      setShots((shotData ?? []) as ShotRow[]);
    } else {
      setShots([]);
    }

    const { data: assetData } = await supabase
      .from('media_assets')
      .select('id, shot_id, attribution, duration_sec')
      .eq('project_id', projectId)
      .eq('type', 'video');
    setAssets((assetData ?? []) as AssetRow[]);

    const { data: jobData } = await supabase
      .from('generation_jobs')
      .select('id, shot_id, status, error')
      .eq('project_id', projectId)
      .eq('step', 'stock');
    setJobs((jobData ?? []) as JobRow[]);
  }, [projectId, supabase]);

  useEffect(() => {
    // A betöltés aszinkron, ezért nem közvetlenül a hatás törzsében hívjuk:
    // így a React hook szabályai szerint sem állítunk állapotot szinkronban.
    const timer = setTimeout(() => {
      void load();
    }, 0);
    return () => clearTimeout(timer);
  }, [load]);

  // A felvételek film sorrendben: jelenetszám, majd felvételszám.
  const orderedShots = [...shots].sort((a, b) => {
    const sa = scenes.find((s) => s.id === a.scene_id)?.number ?? 0;
    const sb = scenes.find((s) => s.id === b.scene_id)?.number ?? 0;
    if (sa !== sb) return sa - sb;
    return a.number - b.number;
  });

  const isApprovedStock =
    !!project?.approved_at && project.mode === 'stock';

  const handleCollect = async () => {
    if (running) return;
    setRunning(true);
    setErrorText('');
    setKeyMissing(false);
    setStatusText('Indul a stock felvételek gyűjtése...');

    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) {
        setErrorText('Nincs aktív bejelentkezés. Kérlek, jelentkezz be újra.');
        return;
      }

      // Egy hívás egyszerre, és csak akkor indul a következő, ha az kész.
      for (;;) {
        const res = await fetch('/api/advance', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ projectId }),
        });
        const data = await res.json().catch(() => null);
        const result = data?.result;

        if (!res.ok && !result) {
          const message = data?.error ?? 'Ismeretlen hiba a stock felvételek gyűjtésekor.';
          if (/PIXABAY_API_KEY/i.test(message)) {
            setKeyMissing(true);
            setStatusText('A Pixabay API kulcs nincs beállítva a szerveren.');
          } else {
            setErrorText(message);
            setStatusText('');
          }
          break;
        }

        const message: string = result?.message ?? '';

        if (message === 'nincs több teendő') {
          setStatusText('Kész: nincs több teendő.');
          break;
        }

        if (message === 'folyamatban') {
          setStatusText('Egy stock feladat még folyamatban van. Próbáld újra később.');
          break;
        }

        if (result?.success === false) {
          if (/PIXABAY_API_KEY/i.test(message)) {
            setKeyMissing(true);
            setStatusText('A Pixabay API kulcs nincs beállítva a szerveren.');
          } else {
            setErrorText(message);
            setStatusText('');
          }
          break;
        }

        setStatusText(message || 'Egy lépés kész...');
        await load();
        await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
      }
    } catch (err: unknown) {
      setErrorText(
        err instanceof Error && err.message
          ? err.message
          : 'Hiba történt a stock felvételek gyűjtésekor.'
      );
      setStatusText('');
    } finally {
      setRunning(false);
      await load();
    }
  };

  return (
    <section className="flex flex-col gap-4 rounded-md border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          Animatic / előnézet — {AGENT4_LABEL}
        </h3>
        <p className="text-xs text-zinc-600 dark:text-zinc-400">
          Költség: 0 USD (stock). Ha bezárod a böngészőt, a folyamat megáll, és
          ugyanezzel a gombbal újraindítható, mert az állapot az adatbázisban van.
        </p>
      </div>

      {isApprovedStock ? (
        <button
          onClick={handleCollect}
          disabled={running}
          className="rounded bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {running ? 'Stock felvételek gyűjtése folyamatban...' : 'Stock felvételek gyűjtése'}
        </button>
      ) : (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          A gomb csak jóváhagyott, Stock módú projektnél jelenik meg.
        </p>
      )}

      {keyMissing && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          A Pixabay API kulcs (PIXABAY_API_KEY) nincs beállítva a szerveren, ezért
          a keresés nem indítható.
        </div>
      )}

      {statusText && (
        <p className="text-xs text-zinc-600 dark:text-zinc-400">{statusText}</p>
      )}

      {errorText && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-400">
          {errorText}
        </div>
      )}

      {orderedShots.length > 0 && (
        <ul className="flex flex-col gap-2">
          {orderedShots.map((shot) => {
            const asset = assets.find((a) => a.shot_id === shot.id);
            const job = jobs.find((j) => j.shot_id === shot.id);
            const url = attributionUrl(asset?.attribution ?? null);
            return (
              <li
                key={shot.id}
                className="rounded border border-zinc-100 p-3 text-xs dark:border-zinc-800"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-zinc-900 dark:text-zinc-100">
                    Jelenet {scenes.find((s) => s.id === shot.scene_id)?.number ?? '?'} / Felvétel {shot.number}
                  </span>
                  <span className="rounded bg-zinc-100 px-2 py-0.5 dark:bg-zinc-800">
                    {AGENT4_LABEL}
                  </span>
                  <span className="text-zinc-500">Állapot: {shot.status}</span>
                </div>

                {asset && (
                  <div className="mt-1 text-zinc-600 dark:text-zinc-400">
                    Forrás:{' '}
                    {url ? (
                      <a href={url} target="_blank" rel="noreferrer" className="underline">
                        {asset.attribution}
                      </a>
                    ) : (
                      (asset.attribution ?? '')
                    )}
                    {asset.duration_sec ? ` — hossz (Pixabay közölte): ${asset.duration_sec} mp` : ''}
                  </div>
                )}

                {shot.qc_notes && (
                  <div className="mt-1 text-amber-700 dark:text-amber-400">{shot.qc_notes}</div>
                )}

                {job?.status === 'failed' && job.error && (
                  <div className="mt-1 text-red-700 dark:text-red-400">Hiba: {job.error}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
