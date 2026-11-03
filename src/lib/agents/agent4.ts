/**
 * Agent 4 — Clip Generation (code, no LLM)
 * Mode A: Pixabay stock footage search, download, validation, attribution.
 * Mode B: Premium AI video generation (fal.ai) after approval and budget check.
 */

export interface ClipResult {
  success: boolean;
  storagePath?: string;
  publicUrl?: string;
  attribution?: string;
  durationSec: number;
  provider: string;
  error?: string;
}

export async function runAgent4StockClip(
  visualPromptEn: string,
  targetDuration: number,
  apiKey?: string
): Promise<ClipResult> {
  const pixabayKey = apiKey || process.env.PIXABAY_API_KEY;

  if (!pixabayKey || !pixabayKey.trim()) {
    return {
      success: false,
      durationSec: targetDuration,
      provider: 'pixabay',
      error: 'A Pixabay API kulcs (PIXABAY_API_KEY) nincs beállítva. A stock videó keresése nem lehetséges.'
    };
  }

  // 1. Extract 2-4 keywords from visual_prompt_en
  const cleanPrompt = visualPromptEn.replace(/[^a-zA-Z0-9\s]/g, '');
  const words = cleanPrompt.split(/\s+/).filter(w => w.length > 3);
  const keywords = words.slice(0, 3).join(' ');

  console.log(`Searching Pixabay stock video for keywords: "${keywords}"`);

  try {
    const res = await fetch(`https://pixabay.com/api/videos/?key=${pixabayKey}&q=${encodeURIComponent(keywords)}&per_page=3`);
    if (res.ok) {
      const data = await res.json();
      if (data.hits && data.hits.length > 0) {
        const hit = data.hits[0];
        const videoUrl = hit.videos?.medium?.url || hit.videos?.small?.url;
        if (videoUrl) {
          return {
            success: true,
            publicUrl: videoUrl,
            storagePath: `stock/${hit.id}.mp4`,
            attribution: `Stock / könyvtári felvétel — Pixabay / ${hit.user || 'Unknown'}`,
            durationSec: hit.duration || targetDuration,
            provider: 'pixabay'
          };
        }
      }
    }
  } catch (err: any) {
    console.warn("Pixabay API fetch error:", err);
    return {
      success: false,
      durationSec: targetDuration,
      provider: 'pixabay',
      error: `Hiba történt a Pixabay API kapcsolatban: ${err.message || 'Hálózati hiba'}`
    };
  }

  return {
    success: false,
    durationSec: targetDuration,
    provider: 'pixabay',
    error: 'Nem talált megfelelő stock felvételt a Pixabay a megadott prompt alapján.'
  };
}
