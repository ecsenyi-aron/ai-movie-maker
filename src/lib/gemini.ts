import { GoogleGenAI, Type, Schema } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY || "";
const ai = new GoogleGenAI({ apiKey });

export interface Agent1Output {
  title: string;
  genre: string;
  scenes: {
    number: number;
    title: string;
    description: string;
    time_of_day: string;
    setting: string;
  }[];
  missing_assets_manifest: string[];
}

export interface Agent2Output {
  screenplay_text: string;
  characters: {
    stable_id: string;
    name: string;
    canonical_description: string;
  }[];
  locations: {
    stable_id: string;
    name: string;
    canonical_description: string;
  }[];
  shots: {
    scene_number: number;
    number: number;
    camera_angle: string;
    camera_movement: string;
    action: string;
    dialogue_hu: string;
    visual_prompt_en: string;
    target_duration_sec: number;
  }[];
}

const agent1Schema: Schema = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING, description: "A film címe magyarul" },
    genre: { type: Type.STRING, description: "Film műfaja" },
    scenes: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          number: { type: Type.INTEGER, description: "Jelenet sorszáma" },
          title: { type: Type.STRING, description: "Jelenet címe" },
          description: { type: Type.STRING, description: "Részletes vizuális leírás magyarul" },
          time_of_day: { type: Type.STRING, description: "Napszak (pl. Nappal, Éjszaka)" },
          setting: { type: Type.STRING, description: "Helyszín neve" }
        },
        required: ["number", "title", "description", "time_of_day", "setting"]
      },
      description: "Háromfelvonásos jelenetstruktúra"
    },
    missing_assets_manifest: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "Hiányzó vagy extra kellékek listája"
    }
  },
  required: ["title", "genre", "scenes", "missing_assets_manifest"]
};

const agent2Schema: Schema = {
  type: Type.OBJECT,
  properties: {
    screenplay_text: { type: Type.STRING, description: "Hagyományos formátumú magyar forgatókönyv szöveg" },
    characters: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          stable_id: { type: Type.STRING, description: "Stabil azonosító (pl. char_anna)" },
          name: { type: Type.STRING, description: "Karakter neve" },
          canonical_description: { type: Type.STRING, description: "Karakter külső leírása angolul vagy magyarul a vizuális kontinuitáshoz" }
        },
        required: ["stable_id", "name", "canonical_description"]
      }
    },
    locations: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          stable_id: { type: Type.STRING, description: "Stabil azonosító (pl. loc_cafe)" },
          name: { type: Type.STRING, description: "Helyszín neve" },
          canonical_description: { type: Type.STRING, description: "Helyszín leírása" }
        },
        required: ["stable_id", "name", "canonical_description"]
      }
    },
    shots: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          scene_number: { type: Type.INTEGER, description: "Melyik jelenethez tartozik" },
          number: { type: Type.INTEGER, description: "Felvétel sorszáma a jeleneten belül" },
          camera_angle: { type: Type.STRING, description: "Kamera szög (pl. close-up, wide)" },
          camera_movement: { type: Type.STRING, description: "Kamera mozgás (pl. pan left, static)" },
          action: { type: Type.STRING, description: "Cselekmény leírása magyarul" },
          dialogue_hu: { type: Type.STRING, description: "Párbeszéd magyarul vagy üres string" },
          visual_prompt_en: { type: Type.STRING, description: "Részletes, fotorealisztikus angol vizuális prompt AI videógenerátorhoz" },
          target_duration_sec: { type: Type.NUMBER, description: "Cél időtartam másodpercben (pl. 4.0)" }
        },
        required: ["scene_number", "number", "camera_angle", "camera_movement", "action", "dialogue_hu", "visual_prompt_en", "target_duration_sec"]
      }
    }
  },
  required: ["screenplay_text", "characters", "locations", "shots"]
};

export async function runAgent1(premise: string): Promise<Agent1Output> {
  const prompt = `Te vagy az 1. Ügynök: Gyártási Vezető (Production Manager) egy AI filmstúdióban.
A feladatod, hogy az alábbi filmötletből (premise) készíts egy strukturált, háromfelvonásos jelenetstruktúrát magyar nyelven.

Filmötlet:
"${premise}"

Készíts 3-6 jelenetet, amelyek logikusan felépítik a történetet (Bevezetés, Tárgyalás/Konfliktus, Tetőpont/Lezárás).`;

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: agent1Schema,
      temperature: 0.7,
    }
  });

  const text = response.text;
  if (!text) {
    throw new Error("Gemini nem adott választ az 1. ügynöknél.");
  }

  return JSON.parse(text) as Agent1Output;
}

export async function runAgent2(premise: string, agent1Result: Agent1Output): Promise<Agent2Output> {
  const prompt = `Te vagy a 2. Ügynök: Forgatókönyvíró & Vizuális Tervező egy AI filmstúdióban.
A feladatod, hogy az alábbi filmötlet és a megadott jelenetstruktúra alapján készíts teljes forgatókönyv szöveget, karaktereket, helyszíneket és részletes felvételeket (shots) angol vizuális promptokkal.

Eredeti ötlet: "${premise}"
Jelenetstruktúra: ${JSON.stringify(agent1Result.scenes)}

Biztosíts stabil ID-kat a karaktereknek és helyszíneknek, és minden shot-hoz adj meg részletes angol visual_prompt_en-t (fotorealisztikus stílusban).`;

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: agent2Schema,
      temperature: 0.7,
    }
  });

  const text = response.text;
  if (!text) {
    throw new Error("Gemini nem adott választ a 2. ügynöknél.");
  }

  return JSON.parse(text) as Agent2Output;
}

export async function testGeminiConnection(): Promise<string> {
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: "Írj egy rövid, 3 szavas üdvözletet magyarul.",
  });
  return response.text || "Sikeres válasz";
}
