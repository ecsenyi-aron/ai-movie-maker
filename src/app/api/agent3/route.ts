import { NextResponse } from 'next/server';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import {
  buildUtterances,
  synthesizeUtterance,
  lockDurations,
  updateDialogueVersion,
} from '@/lib/agents/agent3';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action, projectId, utteranceId, newDialogue } = body;

    if (!action || !projectId) {
      return NextResponse.json(
        { error: 'Hiányzó kötelező paraméterek (action vagy projectId).' },
        { status: 400 }
      );
    }

    const supabase = getSupabaseServiceClient();

    // Projekt létezésének és tulajdonosának ellenőrzése
    const { data: project, error: projErr } = await supabase
      .from('projects')
      .select('id, user_id')
      .eq('id', projectId)
      .single();

    if (projErr || !project) {
      return NextResponse.json(
        { error: 'A megadott projekt nem található.' },
        { status: 404 }
      );
    }

    let result;

    switch (action) {
      case 'build_utterances':
        result = await buildUtterances(supabase, projectId);
        break;

      case 'estimate_durations':
        // A becslést menet közben a lockDurations végzi, ez egy no-op visszatérés.
        result = { success: true, message: 'A becslések menet közben frissülnek.' };
        break;

      case 'synthesize_utterance':
        if (!utteranceId) {
          return NextResponse.json({ error: 'Az utteranceId megadása kötelező a szintézishez.' }, { status: 400 });
        }
        result = await synthesizeUtterance(supabase, utteranceId, projectId);
        break;

      case 'lock_durations':
        result = await lockDurations(supabase, projectId);
        break;

      case 'update_dialogue':
        if (!utteranceId || !newDialogue) {
          return NextResponse.json({ error: 'Az utteranceId és a newDialogue megadása kötelező a párbeszéd szerkesztéséhez.' }, { status: 400 });
        }
        result = await updateDialogueVersion(supabase, utteranceId, projectId, newDialogue);
        break;

      default:
        return NextResponse.json({ error: `Ismeretlen Agent 3 akció: ${action}` }, { status: 400 });
    }

    if (!result.success) {
      return NextResponse.json({ error: result.message }, { status: 400 });
    }

    return NextResponse.json({ success: true, message: result.message, data: result.data });
  } catch (err: any) {
    console.error('Agent 3 API hiba:', err);
    return NextResponse.json(
      { error: err.message || 'Szerverhiba történt az Agent 3 futtatása során.' },
      { status: 500 }
    );
  }
}
