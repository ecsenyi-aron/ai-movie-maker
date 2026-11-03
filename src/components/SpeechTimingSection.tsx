'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/client';

type TtsInfo = {
  status: 'nincs bekapcsolva' | 'nincs ellenőrizve' | 'bekapcsolva';
  enabled: boolean;
  reason: string;
  costStatus: string;
};

type Utterance = {
  id: string;
  shotId: string;
  sceneNumber: number;
  shotNumber: number;
  speaker: string | null;
  text: string;
  version: number;
  hasOlderVersions: boolean;
  hasAudio: boolean;
  audioUrl: string | null;
  measuredDurationSec: number | null;
  estimatedDurationSec: number | null;
  durationSec: number;
  durationIsMeasured: boolean;
};

type Shot = {
  id: string;
  sceneNumber: number;
  shotNumber: number;
  targetDurationSec: number;
  lockedDurationSec: number | null;
  durationEstimated: boolean;
  hasDialogue: boolean;
  lengthened: boolean;
};

type TimelineItem = {
  id: string;
  track: 'video' | 'audio' | 'subtitle';
  shotId: string | null;
  utteranceId: string | null;
  startSeconds: number;
  durationSeconds: number;
  sequenceOrder: number;
  sceneNumber: number | null;
  shotNumber: number | null;
};

type CheckpointData = {
  projectId: string;
  tts: TtsInfo;
  durationsLocked: boolean;
  shots: Shot[];
  utterances: Utterance[];
  timeline: TimelineItem[];
  totalDurationSec: number;
};

function formatSeconds(value: number): string {
  return `${Number(value || 0).toFixed(1).replace('.', ',')} s`;
}

function trackLabel(track: TimelineItem['track']): string {
  if (track === 'video') return 'Videó';
  if (track === 'audio') return 'Hang';
  return 'Felirat';
}

export default function SpeechTimingSection({ projectId }: { projectId: string }) {
  const [data, setData] = useState<CheckpointData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [savingId, setSavingId] = useState<string | null>(null);

  const supabase = useMemo(() => getSupabaseBrowserClient(), []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) {
        setError('Nincs aktív bejelentkezés. Kérlek, jelentkezz be újra.');
        setLoading(false);
        return;
      }

      const res = await fetch(`/api/agent3/checkpoint?projectId=${encodeURIComponent(projectId)}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json?.error || 'A beszéd- és időzítés adatok betöltése nem sikerült.');
        setLoading(false);
        return;
      }

      let payload: CheckpointData = json.data;

      // Ha még nincs beszéd a projektben, előkészítjük (ez nem változtatja a projekt állapotát).
      if (payload.shots.length > 0 && payload.utterances.length === 0) {
        const buildRes = await fetch('/api/agent3/checkpoint', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ action: 'build_utterances', projectId }),
        });
        const buildJson = await buildRes.json();
        if (buildRes.ok && buildJson?.success) {
          const reload = await fetch(
            `/api/agent3/checkpoint?projectId=${encodeURIComponent(projectId)}`,
            { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' }
          );
          const reloadJson = await reload.json();
          if (reload.ok && reloadJson?.data) payload = reloadJson.data;
        }
      }

      setData(payload);
    } catch (err: unknown) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : 'Ismeretlen hiba a beszéd- és időzítés adatok betöltésekor.'
      );
    } finally {
      setLoading(false);
    }
  }, [projectId, supabase]);

  useEffect(() => {
    // A betöltés egy aszinkron callbackben indul, hogy a hatás ne állítsa
    // át szinkronban az állapotot (React szabály: cascading render kerülése).
    const timer = setTimeout(() => {
      void load();
    }, 0);
    return () => clearTimeout(timer);
  }, [load]);

  const startEdit = (u: Utterance) => {
    setEditingId(u.id);
    setDraft(u.text);
    setNotice('');
    setError('');
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraft('');
  };

  const saveEdit = async (u: Utterance) => {
    const text = draft.trim();
    if (!text) {
      setError('A beszéd szövege nem lehet üres. Egy sor eltávolítása más módon történik.');
      return;
    }
    if (text === u.text.trim()) {
      cancelEdit();
      return;
    }

    setSavingId(u.id);
    setError('');
    setNotice('');
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) {
        setError('Nincs aktív bejelentkezés. Kérlek, jelentkezz be újra.');
        return;
      }

      const res = await fetch('/api/agent3/checkpoint', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          action: 'update_dialogue',
          projectId,
          utteranceId: u.id,
          newDialogue: text,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json?.success) {
        setError(json?.error || 'A beszéd mentése nem sikerült.');
        return;
      }

      setNotice(json.message || 'A beszéd mentve.');
      setEditingId(null);
      setDraft('');
      await load();
    } catch (err: unknown) {
      setError(
        err instanceof Error && err.message ? err.message : 'Ismeretlen hiba a beszéd mentésekor.'
      );
    } finally {
      setSavingId(null);
    }
  };

  const lengthenedShots = useMemo(
    () => (data?.shots ?? []).filter((s) => s.lengthened),
    [data]
  );

  return (
    <section className="flex flex-col gap-4 rounded-md border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Beszéd és időzítés
        </h3>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Animatic / előnézet — a párbeszédek, a hangfájlok és az időzítés áttekintése.
        </p>
      </div>

      {/* TTS állapot */}
      <div className="flex flex-col gap-2 rounded border border-zinc-200 bg-zinc-50 p-3 text-xs dark:border-zinc-800 dark:bg-zinc-950/50">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="font-semibold text-zinc-800 dark:text-zinc-200">
            Hanggenerálás (TTS): {data?.tts.status ?? '…'}
          </span>
          <span className="text-zinc-600 dark:text-zinc-400">
            költség: {data?.tts.costStatus ?? 'ismeretlen'}
          </span>
        </div>
        {data && (
          <p className="text-zinc-600 dark:text-zinc-400">{data.tts.reason}</p>
        )}
        <div>
          <button
            type="button"
            disabled
            className="rounded bg-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-600 disabled:cursor-not-allowed dark:bg-zinc-800 dark:text-zinc-500"
          >
            Beszéd generálása
          </button>
          <span className="ml-2 text-zinc-500 dark:text-zinc-400">
            A gomb tiltva: a hanggenerálás nem ellenőrzött, és a költség ismeretlen.
          </span>
        </div>
      </div>

      {loading && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">Betöltés…</p>
      )}

      {error && (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-400">
          {error}
        </div>
      )}

      {notice && !error && (
        <div className="rounded border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-400">
          {notice}
        </div>
      )}

      {data && !loading && (
        <>
          {/* Beszédek listája */}
          <div className="flex flex-col gap-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Beszédek (film sorrendben)
            </h4>

            {data.utterances.length === 0 ? (
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Ebben a projektben még nincs beszéd. A felvételekhez tartozó szöveg a
                „Felvételek és vizuális promptok” részben látható.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {data.utterances.map((u) => {
                  const isEditing = editingId === u.id;
                  const isSaving = savingId === u.id;
                  return (
                    <li
                      key={u.id}
                      className="rounded border border-zinc-200 p-3 text-xs dark:border-zinc-800"
                    >
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="font-semibold text-zinc-800 dark:text-zinc-200">
                          {u.sceneNumber}. jelenet / {u.shotNumber}. felvétel
                        </span>
                        {u.speaker && (
                          <span className="text-zinc-600 dark:text-zinc-400">
                            Szereplő: {u.speaker}
                          </span>
                        )}
                        <span className="text-zinc-500 dark:text-zinc-400">
                          {u.version}. verzió
                        </span>
                        {u.hasOlderVersions && (
                          <span className="text-zinc-500 dark:text-zinc-400">
                            korábbi verzió van
                          </span>
                        )}
                      </div>

                      {isEditing ? (
                        <div className="mt-2 flex flex-col gap-2">
                          <textarea
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            rows={3}
                            className="rounded border border-zinc-300 bg-white p-2 text-xs dark:border-zinc-700 dark:bg-zinc-950"
                          />
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => saveEdit(u)}
                              disabled={isSaving}
                              className="rounded bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
                            >
                              {isSaving ? 'Mentés…' : 'Mentés'}
                            </button>
                            <button
                              type="button"
                              onClick={cancelEdit}
                              disabled={isSaving}
                              className="rounded border border-zinc-300 px-3 py-1.5 text-xs font-medium disabled:opacity-50 dark:border-zinc-700"
                            >
                              Mégsem
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          {u.hasAudio && u.audioUrl ? (
                            <div className="mt-2 flex flex-col gap-1">
                              <audio controls src={u.audioUrl} className="w-full" />
                              <span className="text-zinc-600 dark:text-zinc-400">
                                mért időtartam: {formatSeconds(u.durationSec)}
                              </span>
                            </div>
                          ) : (
                            <div className="mt-2 flex flex-col gap-1">
                              <p className="rounded bg-zinc-100 px-2 py-1 text-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">
                                {u.text}
                              </p>
                              <span className="text-zinc-600 dark:text-zinc-400">
                                becsült időtartam: {formatSeconds(u.durationSec)}
                              </span>
                              <span className="text-zinc-500 dark:text-zinc-400">
                                Nincs hangfájl, felirat jelenik meg.
                              </span>
                            </div>
                          )}

                          <div className="mt-2">
                            <button
                              type="button"
                              onClick={() => startEdit(u)}
                              className="rounded border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                            >
                              Szöveg szerkesztése
                            </button>
                          </div>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Idővonal */}
          <div className="flex flex-col gap-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Idővonal
            </h4>

            {data.durationsLocked && (
              <p className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
                Időtartamok lezárva
              </p>
            )}

            {data.timeline.length === 0 ? (
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Az idővonal még üres.
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {data.timeline.map((item) => (
                  <li
                    key={item.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-zinc-100 px-2 py-1.5 text-xs dark:border-zinc-800"
                  >
                    <span className="w-16 font-medium text-zinc-700 dark:text-zinc-300">
                      {trackLabel(item.track)}
                    </span>
                    <span className="text-zinc-600 dark:text-zinc-400">
                      {item.sceneNumber !== null && item.shotNumber !== null
                        ? `${item.sceneNumber}. jelenet / ${item.shotNumber}. felvétel`
                        : '—'}
                    </span>
                    <span className="text-zinc-600 dark:text-zinc-400">
                      kezdet: {formatSeconds(item.startSeconds)}
                    </span>
                    <span className="text-zinc-600 dark:text-zinc-400">
                      hossz: {formatSeconds(item.durationSeconds)}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
              Teljes hossz: {formatSeconds(data.totalDurationSec)}
            </p>

            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              A kezdőidők és a hosszak a legutóbbi teljes időtartam-lezáráskor lettek
              beállítva. Egy sor szerkesztése után csak az adott felvétel hossza
              frissül, a többi felvétel változatlan marad.
            </p>

            {lengthenedShots.length > 0 && (
              <div className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
                {lengthenedShots.map((s) => (
                  <p key={s.id}>
                    {s.sceneNumber}. jelenet / {s.shotNumber}. felvétel: a felvétel
                    meghosszabbítva a beszéd miatt.
                  </p>
                ))}
              </div>
            )}

            {/* Lezárt időtartamok felvételenként */}
            {data.durationsLocked && (
              <div className="flex flex-col gap-1">
                <h5 className="text-xs font-semibold text-zinc-600 dark:text-zinc-400">
                  Lezárt felvételidőtartamok
                </h5>
                <ul className="flex flex-col gap-1">
                  {data.shots.map((s) => (
                    <li
                      key={s.id}
                      className="flex flex-wrap items-center gap-x-3 text-xs text-zinc-600 dark:text-zinc-400"
                    >
                      <span>
                        {s.sceneNumber}. jelenet / {s.shotNumber}. felvétel
                      </span>
                      <span>
                        időtartam: {formatSeconds(s.lockedDurationSec ?? 0)}
                      </span>
                      {s.durationEstimated && <span>(becsült)</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
