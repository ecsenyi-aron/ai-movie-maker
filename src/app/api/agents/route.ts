import { NextResponse } from 'next/server';
import { runAgent1, runAgent2 } from '@/lib/gemini';
import { processShotAudio } from '@/lib/tts';
import { runAgent4StockClip } from '@/lib/agents/agent4';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action, premise, agent1Result, dialogueHu, targetDuration, visualPromptEn } = body;

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
      const result = await runAgent2(premise, agent1Result);
      return NextResponse.json({ result });
    }

    if (action === 'tts') {
      const ttsResult = await processShotAudio(dialogueHu, targetDuration || 4.0);
      return NextResponse.json({ result: ttsResult });
    }

    if (action === 'agent4') {
      const clipResult = await runAgent4StockClip(visualPromptEn || '', targetDuration || 4.0);
      return NextResponse.json({ result: clipResult });
    }

    return NextResponse.json({ error: 'Ismeretlen akció.' }, { status: 400 });
  } catch (err: any) {
    console.error('API Agents Error:', err);
    return NextResponse.json({ error: err.message || 'Szerverhiba történt az ügynök futtatásakor.' }, { status: 500 });
  }
}
