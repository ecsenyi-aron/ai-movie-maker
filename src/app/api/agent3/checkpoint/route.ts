import { NextResponse } from 'next/server';
import { getSupabaseUserClient } from '@/lib/supabase/server';
import {
  getCheckpointData,
  updateDialogueAndRecompute,
} from '@/lib/agents/agent3-checkpoint';
import { buildUtterances, lockDurations } from '@/lib/agents/agent3';

/**
 * Adatbázis-jogosultság hiba (Postgres 42501: permission denied).
 * Ilyenkor a táblákhoz nincs GRANT a használt szerepkörnek.
 */
function isPermissionError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === '42501') return true;
  return /permission denied|row-level security/i.test(error.message ?? '');
}

/** A felhasználónak érthető, magyar hibaüzenet. */
function permissionMessage(): string {
  return (
    'Az adatbázis nem engedélyezi a hozzáférést ehhez a projekthez. ' +
    'A Supabase-ban a táblákhoz (projects, scenes, shots, utterances, timeline_items, media_assets, characters) ' +
    'még hiányzik a GRANT a service_role és authenticated szerepkörök számára. ' +
    'Ez adatbázis-beállítási probléma, nem a felület hibája.'
  );
}

/**
 * Ellenőrzi, hogy a hívó be van jelentkezve, és a projekt tulajdonosa-e.
 * A hívó saját access tokenjével dolgozunk, így a RLS szabályok érvényesülnek.
 */
async function authorize(request: Request, projectId: string) {
  const header = request.headers.get('authorization') ?? '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { error: 'Nincs aktív bejelentkezés. Kérlek, jelentkezz be újra.' },
        { status: 401 }
      ),
    };
  }

  const supabase = getSupabaseUserClient(token);

  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { error: 'A bejelentkezés érvénytelen vagy lejárt. Kérlek, jelentkezz be újra.' },
        { status: 401 }
      ),
    };
  }

  const { data: project, error: projectErr } = await supabase
    .from('projects')
    .select('id, user_id')
    .eq('id', projectId)
    .maybeSingle();

  if (projectErr) {
    if (isPermissionError(projectErr)) {
      return {
        ok: false as const,
        response: NextResponse.json({ error: permissionMessage() }, { status: 503 }),
      };
    }
    return {
      ok: false as const,
      response: NextResponse.json(
        { error: 'A projekt betöltése nem sikerült. Próbáld újra egy pillanat múlva.' },
        { status: 500 }
      ),
    };
  }

  if (!project) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { error: 'A megadott projekt nem található.' },
        { status: 404 }
      ),
    };
  }

  if (project.user_id !== userData.user.id) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { error: 'Nincs jogosultságod ehhez a projekthez.' },
        { status: 403 }
      ),
    };
  }

  return { ok: true as const, supabase };
}

/** Csak olvas: a checkpointhoz szükséges beszéd-, felvétel- és idővonal-adatok. */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('projectId');
    if (!projectId) {
      return NextResponse.json({ error: 'Hiányzó projectId.' }, { status: 400 });
    }

    const auth = await authorize(request, projectId);
    if (!auth.ok) return auth.response;

    const data = await getCheckpointData(auth.supabase, projectId);
    return NextResponse.json({ success: true, data });
  } catch (err: unknown) {
    console.error('Agent 3 checkpoint GET hiba:', err);
    return NextResponse.json(
      {
        error:
          err instanceof Error && err.message
            ? err.message
            : 'Szerverhiba történt a beszéd- és időzítés adatok betöltésekor.',
      },
      { status: 500 }
    );
  }
}

/**
 * Műveletek:
 *   'update_dialogue'    — szerkesztés + csak az adott beszéd újraszámolása,
 *   'build_utterances'   — a beszédek és az idővonal elemeinek felépítése,
 *   'lock_durations'     — az időtartamok lezárása (a felvételek 'audio_ready' állapotba kerülnek).
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action, projectId, utteranceId, newDialogue } = body ?? {};

    if (!action || !projectId) {
      return NextResponse.json(
        { error: 'Hiányzó kötelező paraméterek (action vagy projectId).' },
        { status: 400 }
      );
    }

    const auth = await authorize(request, projectId);
    if (!auth.ok) return auth.response;

    if (action === 'update_dialogue') {
      if (!utteranceId || typeof newDialogue !== 'string' || !newDialogue.trim()) {
        return NextResponse.json(
          { error: 'A beszéd szövege nem lehet üres. Egy sor eltávolítása más módon történik.' },
          { status: 400 }
        );
      }

      const result = await updateDialogueAndRecompute(
        auth.supabase,
        utteranceId,
        projectId,
        newDialogue
      );
      if (!result.success) {
        return NextResponse.json({ error: result.message }, { status: 400 });
      }
      return NextResponse.json({ success: true, message: result.message, data: result.data });
    }

    if (action === 'build_utterances') {
      const result = await buildUtterances(auth.supabase, projectId);
      if (!result.success) {
        return NextResponse.json({ error: result.message }, { status: 400 });
      }
      return NextResponse.json({ success: true, message: result.message, data: result.data });
    }

    if (action === 'lock_durations') {
      // Az időtartamok lezárása nem módosítja a projekt állapotát.
      const result = await lockDurations(auth.supabase, projectId);
      if (!result.success) {
        return NextResponse.json({ error: result.message }, { status: 400 });
      }
      return NextResponse.json({ success: true, message: result.message, data: result.data });
    }

    return NextResponse.json({ error: `Ismeretlen Agent 3 akció: ${action}` }, { status: 400 });
  } catch (err: unknown) {
    console.error('Agent 3 checkpoint POST hiba:', err);
    return NextResponse.json(
      {
        error:
          err instanceof Error && err.message
            ? err.message
            : 'Szerverhiba történt az Agent 3 művelet során.',
      },
      { status: 500 }
    );
  }
}
