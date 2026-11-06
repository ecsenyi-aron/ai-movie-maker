'use client';

import { useCallback, useEffect, useState } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/client';
import {
  prepareShotsForStock,
  type PrepareAction,
  type PrepareStepResult,
} from '@/lib/agents/agent4-prepare';
import {
  canAffordRetry,
  estimateProjectCostUsd,
  estimateShotVideoCostUsd,
  formatBudgetSummary,
  formatCostText,
  resolveReferenceStatus,
  resolveShotReferenceOwner,
  resolveVideoStatus,
  type UiJob,
  type UiReference,
} from '@/lib/agents/agent4-premium-ui';

const AGENT4_LABEL = 'Stock / könyvtári felvétel';
const PREMIUM_LABEL = 'Prémium felvétel';
const MOCK_PROVIDER_LABEL = 'MOCK Provider aktív';
const PAUSE_MS = 1500;

type ShotRow = {
  id: string;
  scene_id: string;
  number: number;
  status: string;
  qc_notes: string | null;
  speaker_character_id: string | null;
  featured_character_ids: string[];
  target_duration_sec: number | null;
  actual_duration_sec: number | null;
};

type SceneRow = { id: string; number: number; location_id: string | null };

type AssetRow = {
  id: string;
  shot_id: string | null;
  attribution: string | null;
  duration_sec: number | null;
  provider: string | null;
  source_label: string | null;
};

type JobRow = UiJob;

type ProjectRow = {
  id: string;
  mode: string;
  status: string;
  approved_at: string | null;
  budget_usd: number;
};

type OwnerRow = { id: string; name: string };

type ReferenceRow = UiReference;

type BudgetSummary = {
  budget_usd: number;
  spent_usd: number;
  open_reserved_usd: number;
  remaining_usd: number;
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
  const [characters, setCharacters] = useState<OwnerRow[]>([]);
  const [locations, setLocations] = useState<OwnerRow[]>([]);
  const [references, setReferences] = useState<ReferenceRow[]>([]);
  const [budget, setBudget] = useState<BudgetSummary | null>(null);
  const [mockActive, setMockActive] = useState(false);
  const [running, setRunning] = useState(false);
  const [busyShotId, setBusyShotId] = useState<string | null>(null);
  const [statusText, setStatusText] = useState('');
  const [errorText, setErrorText] = useState('');
  const [keyMissing, setKeyMissing] = useState(false);

  const supabase = getSupabaseBrowserClient();

  const load = useCallback(async () => {
    const { data: projectData } = await supabase
      .from('projects')
      .select('id, mode, status, approved_at, budget_usd')
      .eq('id', projectId)
      .maybeSingle();
    setProject((projectData as ProjectRow) ?? null);

    const { data: sceneData } = await supabase
      .from('scenes')
      .select('id, number, location_id')
      .eq('project_id', projectId);
    const sceneRows = (sceneData ?? []) as SceneRow[];
    setScenes(sceneRows);

    const sceneIds = sceneRows.map((s) => s.id);
    if (sceneIds.length > 0) {
      const { data: shotData } = await supabase
        .from('shots')
        .select(
          'id, scene_id, number, status, qc_notes, speaker_character_id, featured_character_ids, target_duration_sec, actual_duration_sec'
        )
        .in('scene_id', sceneIds);
      setShots((shotData ?? []) as ShotRow[]);
    } else {
      setShots([]);
    }

    const { data: assetData } = await supabase
      .from('media_assets')
      .select('id, shot_id, attribution, duration_sec, provider, source_label')
      .eq('project_id', projectId)
      .eq('type', 'video');
    setAssets((assetData ?? []) as AssetRow[]);

    const { data: jobData } = await supabase
      .from('generation_jobs')
      .select(
        'id, shot_id, step, provider, attempt, status, error, reference_owner_type, reference_owner_id, estimated_cost_usd'
      )
      .eq('project_id', projectId);
    setJobs((jobData ?? []) as JobRow[]);

    const { data: characterData } = await supabase
      .from('characters')
      .select('id, name')
      .eq('project_id', projectId);
    setCharacters((characterData ?? []) as OwnerRow[]);

    const { data: locationData } = await supabase
      .from('locations')
      .select('id, name')
      .eq('project_id', projectId);
    setLocations((locationData ?? []) as OwnerRow[]);

    const { data: referenceData } = await supabase
      .from('reference_versions')
      .select('id, owner_type, owner_id, status, storage_path')
      .eq('project_id', projectId);
    setReferences((referenceData ?? []) as ReferenceRow[]);
  }, [projectId, supabase]);

  const loadBudget = useCallback(async () => {
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) return;
      const res = await fetch(`/api/premium-budget?projectId=${encodeURIComponent(projectId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.summary) {
        setBudget(data.summary as BudgetSummary);
      }
    } catch {
      // A költségvetés hiánya nem akadályozza a folyamatot; a szerver az ellenőrzést
      // minden fizetős lépésnél elvégzi.
    }
  }, [projectId, supabase]);

  const loadProviderStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/premium-status');
      const data = await res.json().catch(() => null);
      setMockActive(data?.mockActive === true);
    } catch {
      setMockActive(false);
    }
  }, []);

  useEffect(() => {
    // A betöltés aszinkron, ezért nem közvetlenül a hatás törzsében hívjuk:
    // így a React hook szabályai szerint sem állítunk állapotot szinkronban.
    const timer = setTimeout(() => {
      void load();
      void loadBudget();
      void loadProviderStatus();
    }, 0);
    return () => clearTimeout(timer);
  }, [load, loadBudget, loadProviderStatus]);

  // A felvételek film sorrendben: jelenetszám, majd felvételszám.
  const orderedShots = [...shots].sort((a, b) => {
    const sa = scenes.find((s) => s.id === a.scene_id)?.number ?? 0;
    const sb = scenes.find((s) => s.id === b.scene_id)?.number ?? 0;
    if (sa !== sb) return sa - sb;
    return a.number - b.number;
  });

  const isApprovedStock = !!project?.approved_at && project.mode === 'stock';
  const isApprovedPremium = !!project?.approved_at && project.mode === 'premium';

  const missingReferenceCount = (() => {
    const owners: Array<{ type: 'character' | 'location'; id: string }> = [
      ...characters.map((c) => ({ type: 'character' as const, id: c.id })),
      ...locations.map((l) => ({ type: 'location' as const, id: l.id })),
    ];
    return owners.filter(
      (owner) =>
        !references.some(
          (reference) =>
            reference.owner_type === owner.type &&
            reference.owner_id === owner.id &&
            reference.status === 'approved' &&
            Boolean(reference.storage_path)
        )
    ).length;
  })();

  const estimatedTotalCost = estimateProjectCostUsd({
    missingReferenceCount,
    shots: orderedShots.map((shot) => ({
      durationSec: shot.actual_duration_sec ?? shot.target_duration_sec,
    })),
  });

  const runAdvance = async (
    body: Record<string, unknown>,
    token: string
  ): Promise<{ ok: boolean; message: string }> => {
    const res = await fetch('/api/advance', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ projectId, ...body }),
    });
    const data = await res.json().catch(() => null);
    const result = data?.result;
    if (!res.ok && !result) {
      return { ok: false, message: data?.error ?? 'Ismeretlen hiba a felvételek készítésekor.' };
    }
    return { ok: result?.success === true, message: result?.message ?? '' };
  };

  const handleCollect = async () => {
    if (running) return;
    setRunning(true);
    setErrorText('');
    setKeyMissing(false);
    setStatusText(
      isApprovedPremium
        ? 'Indul a prémium felvételek készítése (referencia képek, majd videók)...'
        : 'Indul a stock felvételek gyűjtése...'
    );

    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) {
        setErrorText('Nincs aktív bejelentkezés. Kérlek, jelentkezz be újra.');
        return;
      }

      // Előkészítés: az Agent 3 lépései (beszédek, majd időtartamok lezárása).
      // Enélkül a felvételek 'planned' állapotban maradnának, és az advance()
      // nem találna 'audio_ready' felvételt.
      setStatusText('A felvételek előkészítése (beszédek és időtartamok)...');
      const prepared = await prepareShotsForStock(async (action: PrepareAction) => {
        const res = await fetch('/api/agent3/checkpoint', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ action, projectId }),
        });
        const data = await res.json().catch(() => null);
        const step: PrepareStepResult = {
          ok: res.ok && data?.success === true,
          message: data?.message ?? data?.error ?? 'Ismeretlen hiba.',
        };
        return step;
      });

      if (!prepared.success) {
        setErrorText(prepared.message);
        setStatusText('');
        return;
      }

      await load();

      // Egy hívás egyszerre, és csak akkor indul a következő, ha az kész.
      for (;;) {
        const outcome = await runAdvance({}, token);
        const message = outcome.message;

        if (message === 'nincs több teendő') {
          setStatusText('Kész: nincs több teendő.');
          break;
        }

        if (message === 'folyamatban') {
          setStatusText('Egy feladat még folyamatban van. Próbáld újra később.');
          break;
        }

        if (!outcome.ok) {
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
        await loadBudget();
        await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
      }
    } catch (err: unknown) {
      setErrorText(
        err instanceof Error && err.message
          ? err.message
          : 'Hiba történt a felvételek készítésekor.'
      );
      setStatusText('');
    } finally {
      setRunning(false);
      await load();
      await loadBudget();
    }
  };

  const handleManualRetry = async (shotId: string) => {
    if (running || busyShotId) return;
    setBusyShotId(shotId);
    setErrorText('');
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) {
        setErrorText('Nincs aktív bejelentkezés. Kérlek, jelentkezz be újra.');
        return;
      }
      const outcome = await runAdvance({ manualRetry: true, retryShotId: shotId }, token);
      if (!outcome.ok) {
        setErrorText(outcome.message || 'Az újrapróbálás nem sikerült.');
      } else {
        setStatusText(outcome.message || 'Az újrapróbálás elindult.');
      }
    } catch (err: unknown) {
      setErrorText(
        err instanceof Error && err.message ? err.message : 'Az újrapróbálás nem sikerült.'
      );
    } finally {
      setBusyShotId(null);
      await load();
      await loadBudget();
    }
  };

  const handleStockFallback = async (shotId: string) => {
    if (running || busyShotId) return;
    setBusyShotId(shotId);
    setErrorText('');
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) {
        setErrorText('Nincs aktív bejelentkezés. Kérlek, jelentkezz be újra.');
        return;
      }
      const outcome = await runAdvance({ stockFallbackShotId: shotId }, token);
      if (!outcome.ok) {
        setErrorText(outcome.message || 'A Stock helyettesítő nem sikerült.');
      } else {
        setStatusText(outcome.message || 'A Stock helyettesítő elindult.');
      }
    } catch (err: unknown) {
      setErrorText(
        err instanceof Error && err.message
          ? err.message
          : 'A Stock helyettesítő nem sikerült.'
      );
    } finally {
      setBusyShotId(null);
      await load();
      await loadBudget();
    }
  };

  return (
    <section className="flex flex-col gap-4 rounded-md border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          {isApprovedPremium ? `Animatic / előnézet — ${PREMIUM_LABEL}` : `Animatic / előnézet — ${AGENT4_LABEL}`}
        </h3>
        <p className="text-xs text-zinc-600 dark:text-zinc-400">
          {isApprovedPremium
            ? 'A lépések sorrendje: először a referencia képek (karakterek és helyszínek), utána a felvételenkénti videók, film sorrendben.'
            : 'Költség: 0 USD (stock). Ha bezárod a böngészőt, a folyamat megáll, és ugyanezzel a gombbal újraindítható, mert az állapot az adatbázisban van.'}
        </p>
      </div>

      {isApprovedPremium && (
        <div className="flex flex-col gap-2 rounded border border-zinc-200 p-3 text-xs dark:border-zinc-800">
          {mockActive && (
            <p className="rounded bg-amber-100 px-2 py-1 font-semibold text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
              {MOCK_PROVIDER_LABEL} — a felvételek tesztanyagok, nem valós AI-kimenetek.
            </p>
          )}
          <p className="text-zinc-600 dark:text-zinc-400">
            Becsült költség (a még hiányzó referenciák és a felvételek videója):
            <span className="font-semibold"> {formatCostText(estimatedTotalCost)}</span>
            {mockActive ? ' (MOCK: szimulált költség, valós kiadás nincs)' : ''}
          </p>
          <p className="text-zinc-600 dark:text-zinc-400">
            {budget
              ? formatBudgetSummary(budget)
              : 'A költségvetés még nem betöltött (a szerver minden fizetős lépésnél ellenőrzi).'}
          </p>
        </div>
      )}

      {isApprovedStock || isApprovedPremium ? (
        <button
          onClick={handleCollect}
          disabled={running}
          className="rounded bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {running
            ? isApprovedPremium
              ? 'Prémium felvételek készítése folyamatban...'
              : 'Stock felvételek gyűjtése folyamatban...'
            : isApprovedPremium
              ? 'Prémium felvételek készítése'
              : 'Stock felvételek gyűjtése'}
        </button>
      ) : (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          A gomb csak jóváhagyott projektnél jelenik meg.
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
            const url = attributionUrl(asset?.attribution ?? null);
            const scene = scenes.find((s) => s.id === shot.scene_id);
            const location = locations.find((l) => l.id === scene?.location_id) ?? null;

            const owner = resolveShotReferenceOwner({
              featuredCharacterIds: shot.featured_character_ids,
              speakerCharacterId: shot.speaker_character_id,
              characters,
              location,
            });

            const referenceStatus = owner
              ? resolveReferenceStatus({
                  ownerType: owner.type,
                  ownerId: owner.id,
                  references,
                  jobs,
                })
              : 'missing';

            const videoView = resolveVideoStatus({
              shotId: shot.id,
              jobs,
              hasAsset: Boolean(asset),
            });

            const shotCost = estimateShotVideoCostUsd(
              shot.actual_duration_sec ?? shot.target_duration_sec
            );
            const retryDecision = canAffordRetry({
              remainingUsd: budget?.remaining_usd ?? 0,
              estimatedCostUsd: shotCost,
              simulated: mockActive,
            });

            const canRetry =
              isApprovedPremium &&
              (videoView.status === 'failed' || videoView.status === 'uncertain') &&
              retryDecision.allowed;
            const canUseStock =
              isApprovedPremium && (videoView.status === 'failed' || videoView.status === 'uncertain');

            return (
              <li
                key={shot.id}
                className="rounded border border-zinc-100 p-3 text-xs dark:border-zinc-800"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-zinc-900 dark:text-zinc-100">
                    Jelenet {scene?.number ?? '?'} / Felvétel {shot.number}
                  </span>
                  <span className="rounded bg-zinc-100 px-2 py-0.5 dark:bg-zinc-800">
                    {isApprovedPremium ? PREMIUM_LABEL : AGENT4_LABEL}
                  </span>
                  <span className="text-zinc-500">Állapot: {shot.status}</span>
                </div>

                {isApprovedPremium && (
                  <div className="mt-1 flex flex-col gap-1 text-zinc-600 dark:text-zinc-400">
                    <span>
                      1. Referencia kép:{' '}
                      <span className="font-medium">
                        {owner
                          ? `${owner.name} (${owner.type === 'character' ? 'karakter' : 'helyszín'})`
                          : 'nincs kiválasztott tulajdonos'}
                      </span>{' '}
                      — {referenceStatus === 'ready' ? 'kész' : referenceStatus === 'pending' ? 'folyamatban' : referenceStatus === 'failed' ? 'sikertelen' : referenceStatus === 'uncertain' ? 'bizonytalan' : 'hiányzik'}
                    </span>
                    <span>
                      2. Videó: <span className="font-medium">{videoView.label}</span>
                      {shotCost !== null ? ` — becsült költség: ${formatCostText(shotCost)}` : ' — becsült költség: ismeretlen'}
                    </span>
                  </div>
                )}

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
                    {asset.duration_sec ? ` — hossz: ${asset.duration_sec} mp` : ''}
                    {asset.source_label === 'mock' ? ' — MOCK / TESZT anyag' : ''}
                  </div>
                )}

                {shot.qc_notes && (
                  <div className="mt-1 text-amber-700 dark:text-amber-400">{shot.qc_notes}</div>
                )}

                {videoView.error && (
                  <div className="mt-1 text-red-700 dark:text-red-400">Hiba: {videoView.error}</div>
                )}

                {isApprovedPremium && (canRetry || canUseStock) && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {canRetry && (
                      <button
                        onClick={() => void handleManualRetry(shot.id)}
                        disabled={running || busyShotId !== null}
                        className="rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                      >
                        {busyShotId === shot.id ? 'Folyamatban...' : 'Újrapróbálás'}
                      </button>
                    )}
                    {canUseStock && (
                      <button
                        onClick={() => void handleStockFallback(shot.id)}
                        disabled={running || busyShotId !== null}
                        className="rounded border border-amber-400 px-2 py-1 text-xs text-amber-800 hover:bg-amber-50 disabled:opacity-50 dark:text-amber-300 dark:hover:bg-amber-950/40"
                      >
                        {busyShotId === shot.id ? 'Folyamatban...' : 'Stock helyettesítő'}
                      </button>
                    )}
                    {!retryDecision.allowed && (
                      <span className="text-zinc-500 dark:text-zinc-400">{retryDecision.reason}</span>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
