import { NextResponse } from 'next/server';
import { runAgent1, runAgent2 } from '@/lib/gemini';
import { processShotAudio } from '@/lib/tts';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action, premise, agent1Result, dialogueHu, targetDuration } = body;

    if (action === 'agent1' || action === 'agent2' || action === 'tts') {
      if (!process.env.GEMINI_API_KEY) {
        return NextResponse.json(
          { error: 'A Gemini API kulcs (GEMINI_API_KEY) nincs beállítva a szerveren. Kérlek add meg a .env.local fájlban.' },
          { status: 400 }
        );
      }
    }

    if (action === 'agent1') {
      if (!premise) {
        return NextResponse.json({ error: 'A filmötlet (premise) hiányzik.' }, { status: 400 });
      }
      const result = await runAgent1(premise);
      return NextResponse.json({ result });
    }

    if (action === 'agent2') {
      if (!premise || !agent1Result) {
        return NextResponse.json({ error: 'Hiányzó paraméterek a 2. ügynökhöz.' }, { status: 400 });
      }
      const validation = await runAgent2(premise, agent1Result);
      return NextResponse.json({
        result: validation.output,
        notes: validation.notes,
        remainingViolations: validation.remainingViolations,
      });
    }

    if (action === 'tts') {
      const ttsResult = await processShotAudio(dialogueHu, targetDuration || 4.0);
      return NextResponse.json({ result: ttsResult });
    }

    return NextResponse.json({ error: 'Ismeretlen akció.' }, { status: 400 });
  } catch (err: unknown) {
    console.error('API Agents Error:', err);
    const message =
      err instanceof Error && err.message
        ? err.message
        : 'Szerverhiba történt az ügynök futtatásakor.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
