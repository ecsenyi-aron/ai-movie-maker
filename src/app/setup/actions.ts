"use server";

import { testGeminiConnection } from "@/lib/gemini";

export async function testGeminiKeyAction(): Promise<{ success: boolean; message: string }> {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return { success: false, message: "A GEMINI_API_KEY nincs beállítva a .env.local fájlban." };
    }
    const result = await testGeminiConnection();
    return { success: true, message: `Gemini API válasz: ${result.trim()}` };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "Ismeretlen hiba történt a Gemini kapcsolat során.",
    };
  }
}
