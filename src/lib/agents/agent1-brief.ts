/**
 * Agent 1 — gyártási terv (brief): zárt szókészletek, típusok és normalizálás.
 * Tiszta modul: nincs hálózat, nincs adatbázis, nincs LLM.
 *
 * A zárt listákon kívüli értékeket a szerver alapértelmezettre cseréli, és ezt
 * a "feltételezések" (assumptions) között jelzi. A folyamatot ez sosem állítja le.
 */

/** A bemenet típusa: egy ötlet, egy vázlat vagy kidolgozott forgatókönyv. */
export const INPUT_TYPES = ['idea', 'outline', 'script'] as const;
export type InputType = (typeof INPUT_TYPES)[number];

/** A műfajok zárt listája (bővíthető itt, egy helyen). */
export const GENRES = [
  'fantasy',
  'sci_fi',
  'drama',
  'comedy',
  'adventure',
  'mystery',
  'horror',
  'romance',
  'family',
] as const;
export type Genre = (typeof GENRES)[number];

/** A vizuális stílusok zárt listája (bővíthető itt, egy helyen). */
export const VISUAL_STYLES = [
  'cinematic_realistic',
  'anime',
  '3d_animation',
  'storybook_illustration',
  'dark_painterly',
] as const;
export type VisualStyle = (typeof VISUAL_STYLES)[number];

/** A film hossza: ez dönt a jelenetek számáról (és így a költségről). */
export const LENGTH_CLASSES = ['short_test', 'short', 'medium'] as const;
export type LengthClass = (typeof LENGTH_CLASSES)[number];

export const DEFAULT_INPUT_TYPE: InputType = 'idea';
export const DEFAULT_GENRE: Genre = 'drama';
export const DEFAULT_VISUAL_STYLE: VisualStyle = 'cinematic_realistic';
export const DEFAULT_LENGTH_CLASS: LengthClass = 'short_test';

/**
 * Jelenetszám-tartomány hosszanként. KIINDULÓ ÉRTÉKEK, nem ellenőrzött adatok:
 * a valódi költség és a Gemini-korlátok ismeretében hangolandók.
 */
export const SCENE_RANGE: Record<LengthClass, { min: number; max: number }> = {
  short_test: { min: 2, max: 3 },
  short: { min: 3, max: 6 },
  medium: { min: 6, max: 10 },
};

/**
 * A stílushoz tartozó, rögzített angol stílusjelölő (az Agent 4 fogja
 * minden képpromptjához hozzáfűzni). KIINDULÓ SZÖVEGEK: egyetlen képmodellel
 * sem ellenőrizve, az első valódi teszt után finomítandók.
 */
export const STYLE_MARKERS: Record<VisualStyle, string> = {
  cinematic_realistic: 'cinematic realistic style, natural lighting, consistent color grading',
  anime: 'anime style, clean line art, consistent cel shading',
  '3d_animation': 'stylized 3D animation, consistent soft lighting',
  storybook_illustration: 'storybook illustration style, watercolor textures, soft palette',
  dark_painterly: 'dark painterly style, moody lighting, textured brush strokes',
};

/** Az LLM által adott feltételezések maximális száma (a szerver megjegyzései ezen felül jönnek). */
export const MAX_ASSUMPTIONS = 12;

export interface BriefCharacter {
  stable_id: string;
  name: string;
  role: string;
  /** Egy soros külső leírás (arc, haj, ruházat), angolul. */
  look: string;
}

export interface BriefLocation {
  stable_id: string;
  name: string;
  description: string;
}

export interface BriefScene {
  number: number;
  title: string;
  description: string;
  time_of_day: string;
  setting: string;
  summary?: string;
  characters_present?: string[];
  /** Javaslat a nehezen megjeleníthető eseményhez (csók, harc, tömeg). */
  framing_hint?: string;
}

/** Az Agent 1 kimenete. A régi mezők változatlanok, az újak opcionálisak. */
export interface Agent1Output {
  title: string;
  genre: string;
  scenes: BriefScene[];
  missing_assets_manifest: string[];
  input_type?: InputType;
  visual_style?: VisualStyle;
  length_class?: LengthClass;
  characters?: BriefCharacter[];
  locations?: BriefLocation[];
  /** Mindaz, amit a modell vagy a szerver döntött, mert a felhasználó nem mondta. */
  assumptions?: string[];
  /** A szerver számolja a jelenetekből, nem az LLM. */
  estimated_scenes_count?: number;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(asString).filter((item) => item.length > 0);
}

function pick<T extends string>(
  allowed: readonly T[],
  value: unknown,
  fallback: T,
  label: string,
  notes: string[]
): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  notes.push(`${label} hiányzott vagy érvénytelen volt, alapértelmezett érték: ${fallback}.`);
  return fallback;
}

/** Stabil azonosító képzése névből (ékezetek nélkül), pl. char_anna. */
export function slugifyId(prefix: string, name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${prefix}_${slug || 'x'}`;
}

function normaliseCharacters(value: unknown): BriefCharacter[] {
  const result: BriefCharacter[] = [];
  if (!Array.isArray(value)) return result;
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const name = asString(record.name);
    if (!name) continue;
    const id = asString(record.stable_id) || slugifyId('char', name);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push({ stable_id: id, name, role: asString(record.role), look: asString(record.look) });
  }
  return result;
}

function normaliseLocations(value: unknown): BriefLocation[] {
  const result: BriefLocation[] = [];
  if (!Array.isArray(value)) return result;
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const name = asString(record.name);
    if (!name) continue;
    const id = asString(record.stable_id) || slugifyId('loc', name);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push({ stable_id: id, name, description: asString(record.description) });
  }
  return result;
}

/** A jeleneteket a tömb sorrendjében 1-től folytonosan számozza újra. */
function normaliseScenes(value: unknown): BriefScene[] {
  const scenes: BriefScene[] = [];
  if (!Array.isArray(value)) return scenes;
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const number = scenes.length + 1;
    scenes.push({
      number,
      title: asString(record.title) || `Jelenet ${number}`,
      description: asString(record.description),
      time_of_day: asString(record.time_of_day),
      setting: asString(record.setting),
      summary: asString(record.summary),
      characters_present: asStringList(record.characters_present),
      framing_hint: asString(record.framing_hint),
    });
  }
  return scenes;
}

/**
 * Az LLM nyers kimenetének normalizálása. Nem dob kivételt.
 * A szerver megjegyzései (notes) a feltételezések végére is bekerülnek.
 */
export function normaliseBrief(raw: unknown): { brief: Agent1Output; notes: string[] } {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const notes: string[] = [];

  const input_type = pick(INPUT_TYPES, source.input_type, DEFAULT_INPUT_TYPE, 'A bemenet típusa', notes);
  const genre = pick(GENRES, source.genre, DEFAULT_GENRE, 'A műfaj', notes);
  const visual_style = pick(VISUAL_STYLES, source.visual_style, DEFAULT_VISUAL_STYLE, 'A vizuális stílus', notes);
  const length_class = pick(LENGTH_CLASSES, source.length_class, DEFAULT_LENGTH_CLASS, 'A film hossza', notes);

  const scenes = normaliseScenes(source.scenes);
  const range = SCENE_RANGE[length_class];
  if (scenes.length === 0) {
    notes.push('Az 1. ügynök nem adott használható jelenetet.');
  } else if (scenes.length < range.min || scenes.length > range.max) {
    notes.push(
      `A jelenetek száma (${scenes.length}) eltér a(z) ${length_class} hossznál várt ${range.min}–${range.max} értéktől.`
    );
  }

  const assumptions = [...asStringList(source.assumptions).slice(0, MAX_ASSUMPTIONS), ...notes];

  const brief: Agent1Output = {
    title: asString(source.title) || 'Névtelen film',
    genre,
    scenes,
    missing_assets_manifest: asStringList(source.missing_assets_manifest),
    input_type,
    visual_style,
    length_class,
    characters: normaliseCharacters(source.characters),
    locations: normaliseLocations(source.locations),
    assumptions,
    estimated_scenes_count: scenes.length,
  };

  return { brief, notes };
}

/** A stílusjelölő lekérése (ismeretlen stílusnál az alapértelmezett). Az Agent 4 használja majd. */
export function getStyleMarker(visualStyle: unknown): string {
  if (typeof visualStyle === 'string' && (VISUAL_STYLES as readonly string[]).includes(visualStyle)) {
    return STYLE_MARKERS[visualStyle as VisualStyle];
  }
  return STYLE_MARKERS[DEFAULT_VISUAL_STYLE];
}