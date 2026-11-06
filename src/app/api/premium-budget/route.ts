import { NextResponse } from 'next/server';
import { getSupabaseUserClient } from '@/lib/supabase/server';
import { getProjectBudgetSummary } from '@/lib/budget';

/**
 * GET /api/premium-budget?projectId=...
 *
 * A Prémium Agent 4 UI számára: költségvetés, elköltött összeg, nyitott
 * foglalás és a még rendelkezésre álló keret. A számítás szerveroldalon,
 * az adatbázis `project_budget_summary` függvényével történik.
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const projectId = url.searchParams.get('projectId');
    if (!projectId) {
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
    const { data: userData, error: userError } = await userClient.auth.getUser(token);
    if (userError || !userData?.user) {
      return NextResponse.json(
        { error: 'A bejelentkezés érvénytelen vagy lejárt. Kérlek, jelentkezz be újra.' },
        { status: 401 }
      );
    }

    const { data: ownedProject, error: ownedError } = await userClient
      .from('projects')
      .select('id')
      .eq('id', projectId)
      .eq('user_id', userData.user.id)
      .maybeSingle();
    if (ownedError || !ownedProject) {
      return NextResponse.json(
        { error: 'Nincs jogosultságod ehhez a projekthez.' },
        { status: 403 }
      );
    }

    const summary = await getProjectBudgetSummary(projectId);
    return NextResponse.json({ summary });
  } catch (err: unknown) {
    const message =
      err instanceof Error && err.message
        ? err.message
        : 'A költségvetés betöltése nem sikerült.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
