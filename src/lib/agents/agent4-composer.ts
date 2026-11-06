/**
 * Agent 4 — Prémium prompt composer (tiszta függvények).
 *
 * Ez a modul NEM hálózatot, NEM adatbázist és NEM providert használ:
 * csak determinisztikus szöveggenerálást végez, ezért unit tesztekkel
 * teljesen lefedhető.
 *
 * A feladat (Task 2/3, STEP 1):
 * - FIXED STYLE MARKER: egyetlen állandó, MINDEN kép promptra appended.
 * - Karakter referencia prompt: egyetlen alany, semleges álló póz,
 *   arc a kamerához vagy háromnegyedben, egyszínű sima háttér,
 *   egyszerű és megkülönböztethető megjelenés, nincs szöveg, nincs logó.
 * - Helyszín referencia prompt: CSAK környezet, nincs ember,
 *   a fények/ légkör az environmental_attributes mezőből jön.
 * - Videó prompt: visual_prompt_en + camera_movement (nincs szanitizáló,
 *   nincs "tier", nincs extra stílusjelölés).
 * - Referencia-választás: pontosan egy főszereplő -> annak a karakternek a
 *   referenciája; egyébként -> helyszín referencia.
 */

/**
 * A FIXED STYLE MARKER — ez kerül minden kép prompt végére.
 * Egyetlen állandó: nem változik felvételenként, nem kerül a videó promptba.
 */
export const FIXED_STYLE_MARKER =
  'cinematic film still, natural lighting, consistent character design, high detail, no text, no watermark, no logo';

/** A composer összes beállítása egyetlen objektumban. */
export const COMPOSER_CONFIG = {
  /** Minden kép promptba appended stílusjelölés. */
  styleMarker: FIXED_STYLE_MARKER,
  /** A karakter referencia kötelező elemei. */
  characterRules: [
    'single subject',
    'neutral standing pose',
    'facing camera or three-quarter view',
    'plain solid-colour background',
    'simple distinctive look',
    'no text',
    'no logo',
  ],
  /** A helyszín referencia kötelező elemei. */
  locationRules: [
    'environment only',
    'no people',
    'no human figures',
    'no text',
    'no logo',
  ],
  /** A videó prompt tiltott elemei (nem kerülhetnek bele). */
  videoForbidden: ['style marker', 'sanitizer', 'tier'],
} as const;

/** A karakter referencia promptjához szükséges adatok. */
export interface CharacterReferenceInput {
  /** A karakter neve (a leírásban szerepelhet). */
  name?: string | null;
  /** A kanonikus külső leírás (Agent 2 adja). */
  canonicalDescription?: string | null;
}

/** A helyszín referencia promptjához szükséges adatok. */
export interface LocationReferenceInput {
  /** A helyszín neve. */
  name?: string | null;
  /** A kanonikus leírás. */
  canonicalDescription?: string | null;
  /** A környezeti attribútumok (fény, időjárás, légkör). */
  environmentalAttributes?: string | null;
}

/** A videó promptjához szükséges adatok. */
export interface VideoPromptInput {
  /** Az Agent 2 által írt vizuális prompt (angol). */
  visualPromptEn?: string | null;
  /** A zárt kameramozgás szókészletből. */
  cameraMovement?: string | null;
  /**
   * Az `elements` tömb elemeinek hivatkozásai (@Element1, @Element2).
   * A hivatalos Kling v3 API-ban a további referencia képek így köthetők
   * a prompt szövegéhez.
   */
  elementReferences?: string[] | null;
}

/** Egy karakter leírása a referencia-választáshoz. */
export interface ReferenceCharacter {
  id: string;
  name?: string | null;
  canonicalDescription?: string | null;
}

/** Egy helyszín leírása a referencia-választáshoz. */
export interface ReferenceLocation {
  id: string;
  name?: string | null;
  canonicalDescription?: string | null;
  environmentalAttributes?: string | null;
}

/** A referencia-választás bemenete. */
export interface ReferenceChoiceInput {
  /** A felvétel főszereplőinek (karakter) azonosítói. */
  featuredCharacterIds?: string[] | null;
  /** A felvétel beszélőjének azonosítója (ha van). */
  speakerCharacterId?: string | null;
  /** A projekttel elérhető karakterek. */
  characters?: ReferenceCharacter[] | null;
  /** A felvétel helyszíne (ha van). */
  location?: ReferenceLocation | null;
}

/** A referencia-választás eredménye. */
export type ReferenceChoice =
  | { kind: 'character'; character: ReferenceCharacter }
  | { kind: 'location'; location: ReferenceLocation }
  | { kind: 'none'; reason: string };

/** A felvétel referencia terve (fő referencia + további referenciák). */
export interface ShotReferencePlan {
  /** A `start_image_url` (fő referencia). */
  primary: { kind: 'character' | 'location'; id: string } | null;
  /** Az `elements` tömb további elemei (másik szereplő, helyszín). */
  additional: Array<{ kind: 'character' | 'location'; id: string }>;
  /** Ha nincs használható referencia, akkor a magyarázat. */
  reason: string | null;
}

/** Emberre utaló szavak — a helyszín promptban tilosak. */
export const PERSON_TERMS = [
  'person',
  'people',
  'man',
  'men',
  'woman',
  'women',
  'boy',
  'girl',
  'child',
  'children',
  'human',
  'crowd',
  'figure',
  'silhouette',
  'portrait',
  'character',
  'actor',
  'actress',
  'személy',
  'ember',
  'férfi',
  'nő',
  'gyerek',
  'tömeg',
];

/** Összefűzi a nem üres részeket egyetlen mondattá. */
function joinParts(parts: (string | null | undefined)[]): string {
  return parts
    .map((p) => (p ?? '').trim())
    .filter((p) => p.length > 0)
    .join(', ');
}

/** Kisbetűsítés, hogy a szabályellenőrzés stabil legyen. */
function lower(value: string): string {
  return value.toLowerCase();
}

/**
 * Karakter referencia prompt.
 * Egyetlen alany, semleges álló póz, arc a kamerához vagy háromnegyedben,
 * egyszínű sima háttér, egyszerű megkülönböztethető megjelenés, nincs szöveg/logó.
 */
export function composeCharacterReferencePrompt(input: CharacterReferenceInput): string {
  const description = (input.canonicalDescription ?? '').trim();
  const name = (input.name ?? '').trim();
  const subject = joinParts([name, description]);
  const body = joinParts([
    subject ? `portrait of ${subject}` : 'portrait of a character',
    'single subject',
    'neutral standing pose',
    'facing camera or three-quarter view',
    'plain solid-colour background',
    'simple distinctive look',
    'no text',
    'no logo',
  ]);
  return `${body}, ${FIXED_STYLE_MARKER}`;
}

/**
 * Helyszín referencia prompt.
 * CSAK környezet, nincs ember; a fény és a légkör az environmental_attributes-ből jön.
 */
export function composeLocationReferencePrompt(input: LocationReferenceInput): string {
  const description = (input.canonicalDescription ?? '').trim();
  const name = (input.name ?? '').trim();
  const environment = joinParts([name, description]);
  const atmosphere = (input.environmentalAttributes ?? '').trim();
  const body = joinParts([
    environment ? `empty environment of ${environment}` : 'empty environment',
    atmosphere ? `lighting and atmosphere: ${atmosphere}` : null,
    'environment only',
    'no people',
    'no human figures',
    'no text',
    'no logo',
  ]);
  return `${body}, ${FIXED_STYLE_MARKER}`;
}

/**
 * Videó prompt a felvételhez: visual_prompt_en + camera_movement.
 * Nem tartalmaz stílusjelölést, szanitizálót vagy "tier"-t.
 */
export function composeVideoPrompt(input: VideoPromptInput): string {
  const visual = (input.visualPromptEn ?? '').trim();
  const movement = (input.cameraMovement ?? '').trim();
  const body = joinParts([visual, movement ? `camera movement: ${movement}` : null]);
  const elements = (input.elementReferences ?? [])
    .map((reference) => reference.trim())
    .filter((reference) => reference.length > 0);
  if (elements.length === 0) return body;
  // A hivatalos Kling v3 API-ban az `elements` tömb elemeire a promptban
  // @Element1, @Element2 formában lehet hivatkozni.
  return joinParts([body, `featuring ${elements.join(' ')}`]);
}

/**
 * Referencia-választás egy felvételhez.
 * Pontosan egy főszereplő -> az ő karakter-referenciája; egyébként -> helyszín.
 */
export function chooseReferenceForShot(input: ReferenceChoiceInput): ReferenceChoice {
  const characters = input.characters ?? [];
  const featured = (input.featuredCharacterIds ?? []).filter(
    (id): id is string => typeof id === 'string' && id.length > 0
  );

  if (featured.length === 1) {
    const found = characters.find((c) => c.id === featured[0]);
    if (found) return { kind: 'character', character: found };
    return { kind: 'none', reason: 'A főszereplő karakter-referenciája nem található.' };
  }

  if (featured.length > 1) {
    return { kind: 'none', reason: 'Több főszereplő van a felvételben, nincs egyértelmű referencia.' };
  }

  // Nincs főszereplő: a beszélő számít, ha pontosan egy van.
  const speaker = (input.speakerCharacterId ?? '').trim();
  if (speaker) {
    const found = characters.find((c) => c.id === speaker);
    if (found) return { kind: 'character', character: found };
  }

  if (input.location) return { kind: 'location', location: input.location };

  return { kind: 'none', reason: 'A felvételhez sem karakter-, sem helyszín-referencia nem érhető el.' };
}

/**
 * A felvételhez használható referenciák terve (multi-reference).
 *
 * - A főszereplők (egy vagy több) karakter-referenciái: az első a fő
 *   referencia (`start_image_url`), a többi az `elements` tömbbe kerül.
 * - Nincs főszereplő, de van beszélő -> a beszélő karakter-referenciája.
 * - Nincs egyik sem -> a helyszín referenciája.
 * - A helyszín (ha van) mindig kikerül a további referenciák közé, mert a
 *   jelenet helyszíne is fontos vizuális támpont.
 */
export function planShotReferences(input: ReferenceChoiceInput): ShotReferencePlan {
  const characters = input.characters ?? [];
  const featured = (input.featuredCharacterIds ?? []).filter(
    (id): id is string => typeof id === 'string' && id.length > 0
  );

  const featuredCharacters = featured
    .map((id) => characters.find((character) => character.id === id))
    .filter((character): character is ReferenceCharacter => Boolean(character));

  const speaker = (input.speakerCharacterId ?? '').trim();
  const speakerCharacter = speaker
    ? characters.find((character) => character.id === speaker)
    : undefined;

  const primaryCharacter = featuredCharacters[0] ?? speakerCharacter;
  const additionalCharacters = featuredCharacters.slice(1);

  const primary = primaryCharacter
    ? { kind: 'character' as const, id: primaryCharacter.id }
    : input.location
      ? { kind: 'location' as const, id: input.location.id }
      : null;

  const additional: Array<{ kind: 'character' | 'location'; id: string }> =
    additionalCharacters.map((character) => ({ kind: 'character' as const, id: character.id }));

  // A helyszín referencia akkor is kikerül, ha van főszereplő: a jelenet
  // helyszíne is vizuális támpont, és a modell az `elements` tömbben kapja.
  if (input.location && primary?.kind !== 'location') {
    additional.push({ kind: 'location', id: input.location.id });
  }

  if (!primary) {
    return {
      primary: null,
      additional: [],
      reason: 'A felvételhez sem karakter-, sem helyszín-referencia nem érhető el.',
    };
  }

  return { primary, additional, reason: null };
}

/**
 * Igaz, ha a helyszín prompt nem tartalmaz emberre utaló kifejezést.
 * A "no people" tiltás önmagában nem számít emberutalásnak.
 */
export function locationPromptHasNoPeople(prompt: string): boolean {
  // A negatív tiltásokat ("no people", "no human figures") előbb kivesszük,
  // különben a saját tiltó szavaink számítanának emberutalásnak.
  // A FIXED STYLE MARKER-t is levesszük: a "consistent character design"
  // nem a helyszín leírása, hanem az állandó stílusjelölés.
  const text = lower(prompt)
    .replace(lower(FIXED_STYLE_MARKER), '')
    .replace(/no human figures/g, '')
    .replace(/no people/g, '')
    .replace(/no person/g, '');
  // Szóhatáros egyezés: a "man" szó nem egyezik a "human" szóban,
  // a "men" pedig nem a "environment" szóban.
  return !PERSON_TERMS.some((term) => new RegExp(`\\b${term}\\b`).test(text));
}

/** Igaz, ha a videó prompt nem tartalmaz tiltott elemet. */
export function videoPromptIsClean(prompt: string): boolean {
  const text = lower(prompt);
  if (text.includes(lower(FIXED_STYLE_MARKER))) return false;
  if (text.includes('sanitizer')) return false;
  if (text.includes('tier')) return false;
  return true;
}
