/**
 * Agent 4 — Stock (Pixabay) tiszta segédfüggvények.
 *
 * Ez a modul NEM hálózatot és NEM adatbázist használ: tiszta, determinisztikus
 * függvények, amelyeket könnyű tesztelni.
 *
 * Tények a Pixabay hivatalos API-dokumentációjából (ellenőrzött):
 * - A videókeresésnél nincs tájolási paraméter, a fekvő/álló szűrést mi végezzük.
 * - A `large` rendition lehet üres (0 bájt), ezért csak `small` (tartalék `tiny`) használható.
 * - A `small` jellemzően 1280x720.
 */

/**
 * Maximum feltöltési méret egy stock kliphez.
 *
 * A Supabase Storage free csomagban 50 MB a globális limit (hivatalos
 * dokumentáció, ellenőrzött), ezért 40 MB-ot állítunk be. A bucket-szintű
 * limit a migrációban 100 MB, de az nem lehet nagyobb a globálisnál.
 * Állítható konstans.
 */
export const MAX_CLIP_BYTES = 40 * 1024 * 1024;

/** A Pixabay `q` paraméterének maximum hossza. */
export const MAX_QUERY_LENGTH = 100;

/** English stopwords (kis, gyakori szavak). */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'of', 'in', 'on', 'at', 'to',
  'for', 'with', 'from', 'by', 'is', 'are', 'was', 'were', 'be', 'being',
  'been', 'this', 'that', 'these', 'those', 'it', 'its', 'as', 'into', 'over',
  'under', 'then', 'than', 'so', 'not', 'no', 'yes', 'very', 'more', 'most',
  'some', 'any', 'all', 'each', 'he', 'she', 'they', 'we', 'you', 'his', 'her',
  'their', 'our', 'your', 'my', 'me', 'him', 'them', 'us', 'who', 'which',
  'what', 'when', 'where', 'why', 'how', 'while', 'during', 'after', 'before',
  'up', 'down', 'out', 'off', 'again', 'once', 'here', 'there', 'will',
  'would', 'can', 'could', 'should', 'shall', 'may', 'might', 'must', 'do',
  'does', 'did', 'done', 'has', 'have', 'had', 'having', 'am', 'be', 'been',
]);

/** Látványtechnikai / filmszakmai szavak, amelyek nem jó keresési kulcsszavak. */
const CINEMATIC_JARGON = new Set([
  'cinematic', 'cinematography', 'closeup', 'close', 'wide', 'shot', 'shots',
  'pan', 'panning', 'dolly', 'zoom', 'zooming', 'tilt', 'crane', 'handheld',
  'tracking', 'aerial', 'drone', 'macro', 'telephoto', 'lens', 'camera',
  'angle', 'angles', 'movement', 'view', 'viewpoint', 'perspective',
  'composition', 'framing', 'frame', 'frames', 'footage', 'video', 'clip',
  'film', 'scene', 'scenes', 'sequence', 'moment', 'bokeh', 'depth', 'field',
  'focus', 'lighting', 'light', 'lit', 'shadow', 'shadows', 'color', 'colour',
  'colors', 'colours', 'tone', 'mood', 'atmosphere', 'atmospheric', 'style',
  'styled', 'look', 'looks', 'looking', 'feels', 'feeling', 'cinematography',
  'establishing', 'insert', 'cutaway', 'overthe', 'shoulder', 'pov', 'point',
  'view', 'hd', 'uhd', 'fps', 'resolution', 'quality', 'render', 'rendered',
  'slow', 'motion', 'fast', 'action', 'setting', 'settings', 'environment',
  'background', 'foreground', 'closeup', 'wideangle', 'golden', 'hour', 'hours',
  'time', 'timing', 'day', 'night', 'morning', 'evening', 'sunset', 'sunrise',
]);

export interface PixabayRendition {
  url: string;
  width: number;
  height: number;
  size: number;
  thumbnail?: string;
}

export interface PixabayHit {
  id: number | string;
  pageURL: string;
  type?: string;
  tags?: string;
  duration: number;
  user?: string;
  user_id?: number | string;
  videos?: {
    large?: PixabayRendition;
    medium?: PixabayRendition;
    small?: PixabayRendition;
    tiny?: PixabayRendition;
  };
}

export interface PickedClip {
  hit: PixabayHit;
  rendition: PixabayRendition;
  /** Melyik renditionet használjuk: 'small' vagy 'tiny'. */
  renditionKey: 'small' | 'tiny';
  url: string;
  width: number;
  height: number;
  size: number;
  /** A Pixabay által közölt időtartam, másodpercben. */
  duration: number;
}

function normalizeWord(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * 2–4 egyszerű angol kulcsszó a vizuális promptból.
 * Determinisztikus: nincs LLM, nincs véletlen, ugyanaz a bemenet ugyanazt adja.
 * A kamerás/filmszakmi szavak és a stopwordok kiesnek.
 */
export function extractKeywords(visualPromptEn: string): string {
  const raw = (visualPromptEn ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const seen = new Set<string>();
  const kept: string[] = [];

  for (const token of raw) {
    const word = normalizeWord(token);
    if (!word || word.length < 3) continue;
    if (STOPWORDS.has(word)) continue;
    if (CINEMATIC_JARGON.has(word)) continue;
    if (seen.has(word)) continue;
    seen.add(word);
    kept.push(word);
    if (kept.length >= 4) break;
  }

  // Ha túl kevés maradt, pótoljuk a stopword/jargon nélküli nyers szavakkal.
  if (kept.length < 2) {
    for (const token of raw) {
      const word = normalizeWord(token);
      if (!word || word.length < 3) continue;
      if (seen.has(word)) continue;
      seen.add(word);
      kept.push(word);
      if (kept.length >= 2) break;
    }
  }

  let query = kept.join(' ');
  if (query.length > MAX_QUERY_LENGTH) {
    query = query.slice(0, MAX_QUERY_LENGTH);
    const lastSpace = query.lastIndexOf(' ');
    if (lastSpace > 0) query = query.slice(0, lastSpace);
  }
  return query.trim();
}

/**
 * Kiválasztja a megfelelő fekvő (width > height) felvételt.
 *
 * Szabályok:
 * - csak `small` rendition (tartalék `tiny`), SOHA `large`;
 * - csak fekvő videó (width > height);
 * - a fájlméret nem lehet nagyobb a MAX_CLIP_BYTES limitnél;
 * - a felvétel időtartama legalább a szükséges (lezárt) időtartam;
 * - a legkisebb elég hosszú időtartamú felvétel nyer;
 * - ha egyik sem elég hosszú, null (nincs "legközelebbi" trükk, nincs
 *   befagyasztott képkocka).
 */
export function pickClip(
  hits: PixabayHit[] | null | undefined,
  neededSeconds: number
): PickedClip | null {
  if (!Array.isArray(hits) || hits.length === 0) return null;
  const needed = Number(neededSeconds);
  if (!Number.isFinite(needed) || needed <= 0) return null;

  const candidates: PickedClip[] = [];

  for (const hit of hits) {
    if (!hit || !hit.videos) continue;
    const small = hit.videos.small;
    const tiny = hit.videos.tiny;
    const rendition = small && small.url ? small : tiny && tiny.url ? tiny : null;
    if (!rendition) continue;

    const renditionKey: 'small' | 'tiny' = small && small.url ? 'small' : 'tiny';
    const width = Number(rendition.width);
    const height = Number(rendition.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) continue;
    if (!(width > height)) continue; // csak fekvő

    const size = Number(rendition.size ?? 0);
    if (Number.isFinite(size) && size > MAX_CLIP_BYTES) continue;

    const duration = Number(hit.duration);
    if (!Number.isFinite(duration) || duration < needed) continue;

    candidates.push({
      hit,
      rendition,
      renditionKey,
      url: rendition.url,
      width,
      height,
      size: Number.isFinite(size) ? size : 0,
      duration,
    });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.duration !== b.duration) return a.duration - b.duration;
    if (a.size !== b.size) return a.size - b.size;
    return String(a.hit.id).localeCompare(String(b.hit.id));
  });

  return candidates[0];
}

/** Forrásmegjelölés a Pixabay találathoz. */
export function buildAttribution(hit: PixabayHit): string {
  const user = (hit?.user ?? '').trim() || 'ismeretlen felhasználó';
  const page = (hit?.pageURL ?? '').trim();
  return `Videó: ${user} / Pixabay – ${page}`;
}

export interface DownloadHeaders {
  contentType?: string | null;
  contentLength?: number | null;
}

export interface DownloadValidation {
  ok: boolean;
  error?: string;
}

/**
 * Letöltött fájl ellenőrzése.
 *
 * ELV: üres fájl, nem video/* típus, túl nagy méret vagy nem MP4-szerű
 * aláírás esetén elutasítjuk.
 *
 * Őszinte megjegyzés: ez NEM bizonyítja, hogy a fájl lejátszható. A valódi
 * lejátszhatóságot később, az Agent 5 ellenőrzi a böngészőben.
 */
export function validateDownload(
  bytes: Uint8Array | ArrayBuffer | null | undefined,
  headers: DownloadHeaders = {}
): DownloadValidation {
  const data =
    bytes instanceof Uint8Array
      ? bytes
      : bytes instanceof ArrayBuffer
        ? new Uint8Array(bytes)
        : null;

  if (!data || data.byteLength === 0) {
    return { ok: false, error: 'A letöltött fájl üres.' };
  }

  const contentType = (headers.contentType ?? '').split(';')[0].trim().toLowerCase();
  if (!contentType.startsWith('video/')) {
    return {
      ok: false,
      error: `A letöltött fájl nem videó (típus: ${contentType || 'ismeretlen'}).`,
    };
  }

  const declaredLength = Number(headers.contentLength);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CLIP_BYTES) {
    return {
      ok: false,
      error: 'A letöltött fájl nagyobb a megengedett méretnél (40 MB).',
    };
  }

  if (data.byteLength > MAX_CLIP_BYTES) {
    return {
      ok: false,
      error: 'A letöltött fájl nagyobb a megengedett méretnél (40 MB).',
    };
  }

  // MP4 aláírás: a 'ftyp' doboz a fejlécben (általában a 4. bájtnál kezdődik).
  const head = data.subarray(0, Math.min(data.byteLength, 64));
  let hasFtyp = false;
  for (let i = 0; i + 4 <= head.length; i++) {
    if (
      head[i] === 0x66 && // f
      head[i + 1] === 0x74 && // t
      head[i + 2] === 0x79 && // y
      head[i + 3] === 0x70 // p
    ) {
      hasFtyp = true;
      break;
    }
  }
  if (!hasFtyp) {
    return { ok: false, error: 'A letöltött fájl nem MP4 formátumú (hiányzik az ftyp aláírás).' };
  }

  return { ok: true };
}
