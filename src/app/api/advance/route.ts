import { NextResponse } from 'next/server';
import { getSupabaseServiceClient, getSupabaseUserClient } from '@/lib/supabase/server';
import { advance } from '@/lib/agents/agent4';

/**
 * POST /api/advance
 *
 * Body: { projectId: string }
 *
 * Egyetlen rövid lépést végez az Agent 4 (Stock / Pixabay) folyamatban.
 * A felhasználói kliens a hívó access tokenjével készül (RLS), a
 * privilegizált kliens csak a szerveren létezik. A Pixabay-kulcs és a
 * service role kulcs soha nem kerül a böngészőbe.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const projectId = body?.projectId as string | undefined;

    if (!projectId || typeof projectId !== 'string') {
      return NextResponse.json(
        { error: 'A projekt azonosítója (projectId) hiányzik.' },
        { status: 400 }
      );
    }

    const header = request.headers.get('authorization') ?? '';
    const token = header.replace(/^Bearer\s+/i, '').trim();
    if (!token) {
      return NextResponse.json(
        { error: 'Nincs aktív bejelentkezés. Kérlek, jelentkezz be újra.' },
        { status: 401 }
      );
    }

    const userClient = getSupabaseUserClient(token);

    const { data: userData, error: userErr } = await userClient.auth.getUser(token);
    if (userErr || !userData?.user) {
      return NextResponse.json(
        { error: 'A bejelentkezés érvénytelen vagy lejárt. Kérlek, jelentkezz be újra.' },
        { status: 401 }
      );
    }

    const adminClient = getSupabaseServiceClient();

    const result = await advance(userClient, adminClient, projectId);

    // A "folyamatban" állapot nem hiba, csak tájékoztató.
    const status = result.success ? 200 : result.message === 'folyamatban' ? 409 : 400;

    return NextResponse.json({ result }, { status });
  } catch (err: unknown) {
    const message =
      err instanceof Error && err.message
        ? err.message
        : 'Szerverhiba történt a stock felvételek gyűjtésekor.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
