/**
 * Agent 2 — felvételírási szabályok (tiszta modul, nincs hálózat, nincs adatbázis).
 *
 * A minőség itt dől el: zárt szókészletek + rövid írási szabályok.
 * A modul célja:
 * - zárt szókészlet a kameraszögekhez és kameramozgásokhoz,
 * - a régi, szabad szöveges értékek normalizálása KÓDban (a régi sorok nem íródnak át),
 * - determinisztikus validator az 1–5. írási szabályra,
 * - `isLipsyncEligible()` — a lip-sync előfeltétele, igény szerint számolva.
 *
 * A validator SOHA nem állítja le a folyamatot: a hiba a javítási útvonalon
 * egyszer végighajt, majd a maradék problémát normalizálással rendezzük.
 */

/** A zárt kameraszög szókészlet. */
export const CAMERA_ANGLES = [
  'extreme_wide',
  'wide',
  'medium',
  'medium_close',
  'close_up',
] as const;

export type CameraAngle = (typeof CAMERA_ANGLES)[number];

/** A zárt kameramozgás szókészlet. */
export const CAMERA_MOVEMENTS = [
  'static',
  'slow_push_in',
  'slow_pan',
  'slow_tilt',
] as const;

export type CameraMovement = (typeof CAMERA_MOVEMENTS)[number];

/** A beszédmód: kamerában látható beszéd vagy voice-over. */
export const DIALOGUE_MODES = ['on_camera', 'voice_over', 'none'] as const;

export type DialogueMode = (typeof DIALOGUE_MODES)[number];

/** Az alapértelmezett kameraszög (normalizáláskor). */
export const DEFAULT_CAMERA_ANGLE: CameraAngle = 'medium';

/** Az alapértelmezett kameramozgás (normalizáláskor). */
export const DEFAULT_CAMERA_MOVEMENT: CameraMovement = 'static';

/** A közeli kameraszögek (2. és 3. szabály). */
export const CLOSE_ANGLES: readonly CameraAngle[] = ['medium', 'medium_close', 'close_up'];

/** A beszélő-közeli kameraszögek (5. szabály). */
export const SPEAKING_ANGLES: readonly CameraAngle[] = ['medium_close', 'close_up'];

/** Az engedélyezett kameramozgások beszéd közben (5. szabály). */
export const SPEAKING_MOVEMENTS: readonly CameraMovement[] = ['static', 'slow_push_in'];

/**
 * A több ütemben zajló cselekményre utaló tiltott szavak (1. szabály).
 * Kisbetűs, szóhatáros egyezéssel ellenőrizzük.
 */
export const MULTI_BEAT_WORDS: readonly string[] = [
  'then',
  'suddenly',
  'cut to',
  'meanwhile',
  'after that',
  'and then',
  'next,',
  'followed by',
  'as soon as',
  'moments later',
];

/** Csoportos jelenetekre utaló kulcsszavak (2. szabály). */
export const GROUP_SCENE_WORDS: readonly string[] = [
  'crowd',
  'crowds',
  'group',
  'groups',
  'mob',
  'army',
  'battle',
  'war',
  'riot',
  'protest',
  'street',
  'streets',
  'market',
  'audience',
  'people',
  'tömeg',
  'csoport',
  'utca',
  'háború',
  'tüntetés',
];

/**
 * Tiltott fő téma: olvasható szöveg, finom kézimunka, szoros testi kontaktus
 * két szereplő között (4. szabály).
 */
export const BANNED_CLOSE_SUBJECTS: readonly string[] = [
  'readable text',
  'readable sign',
  'sign text',
  'text on screen',
  'on-screen text',
  'close-up of hands',
  'close up of hands',
  'hands writing',
  'fine hand',
  'hand manipulation',
  'hugging',
  'kissing',
  'embrace',
  'holding hands',
  'physical contact',
  'olvasható szöveg',
  'kézimunka',
  'ölelés',
  'csókolás',
];

/** A legacy (szabad szöveges) kameraszög értékek normalizálási térképe. */
const ANGLE_ALIASES: Record<string, CameraAngle> = {
  extreme_wide: 'extreme_wide',
  'extreme wide': 'extreme_wide',
  'extreme-wide': 'extreme_wide',
  'extreme wide shot': 'extreme_wide',
  'very wide': 'extreme_wide',
  establishing: 'extreme_wide',
  wide: 'wide',
  'wide shot': 'wide',
  'long shot': 'wide',
  full: 'wide',
  'full shot': 'wide',
  medium: 'medium',
  'medium shot': 'medium',
  mid: 'medium',
  'medium close': 'medium_close',
  'medium-close': 'medium_close',
  'medium close-up': 'medium_close',
  'medium_close-up': 'medium_close',
  'medium close up': 'medium_close',
  medium_close: 'medium_close',
  close: 'close_up',
  'close up': 'close_up',
  'close-up': 'close_up',
  closeup: 'close_up',
  close_up: 'close_up',
  'close up shot': 'close_up',
};

/** A legacy (szabad szöveges) kameramozgás értékek normalizálási térképe. */
const MOVEMENT_ALIASES: Record<string, CameraMovement> = {
  static: 'static',
  still: 'static',
  fixed: 'static',
  locked: 'static',
  none: 'static',
  'no movement': 'static',
  'push in': 'slow_push_in',
  'push-in': 'slow_push_in',
  'slow push in': 'slow_push_in',
  'slow_push_in': 'slow_push_in',
  dolly_in: 'slow_push_in',
  'dolly in': 'slow_push_in',
  'zoom in': 'slow_push_in',
  pan: 'slow_pan',
  'slow pan': 'slow_pan',
  'pan left': 'slow_pan',
  'pan right': 'slow_pan',
  slow_pan: 'slow_pan',
  tracking: 'slow_pan',
  tilt: 'slow_tilt',
  'slow tilt': 'slow_tilt',
  'tilt up': 'slow_tilt',
  'tilt down': 'slow_tilt',
  slow_tilt: 'slow_tilt',
};

/** Egy szöveg kisbetűs, szóhatáros előfordulását ellenőrzi. */
export function containsPhrase(text: string | null | undefined, phrase: string): boolean {
  if (!text) return false;
  const haystack = text.toLowerCase();
  const needle = phrase.toLowerCase();
  if (needle.includes(' ') || needle.includes('-') || needle.includes(',')) {
    return haystack.includes(needle);
  }
  const pattern = new RegExp(`(^|[^a-z0-9_])${escapeRegExp(needle)}([^a-z0-9_]|$)`, 'i');
  return pattern.test(haystack);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Igaz, ha az érték már a zárt szókészlet tagja. */
export function isCameraAngle(value: unknown): value is CameraAngle {
  return typeof value === 'string' && (CAMERA_ANGLES as readonly string[]).includes(value);
}

/** Igaz, ha az érték már a zárt szókészlet tagja. */
export function isCameraMovement(value: unknown): value is CameraMovement {
  return typeof value === 'string' && (CAMERA_MOVEMENTS as readonly string[]).includes(value);
}

/**
 * Előkészíti a legacy szöveget a szókészlet-kereséshez:
 * - levágja a "pl." / "pl" előtagot,
 * - a vesszővel felsorolt listából az első elemet veszi,
 * - kisbetűsíti és a szóközöket rendezi.
 */
function legacyKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^pl\.?\s+/, '')
    .split(',')[0]
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Normalizál egy kameraszöget a zárt szókészletre.
 * Ismeretlen érték esetén az alapértelmezettet adja vissza.
 */
export function normalizeCameraAngle(value: unknown): CameraAngle {
  if (isCameraAngle(value)) return value;
  if (typeof value !== 'string') return DEFAULT_CAMERA_ANGLE;
  const key = legacyKey(value);
  const direct = ANGLE_ALIASES[key];
  if (direct) return direct;
  // Tartalmi visszaesés: a kulcsszó alapján a legközelebbi zárt érték.
  if (key.includes('medium close')) return 'medium_close';
  if (key.includes('close')) return 'close_up';
  if (key.includes('extreme') || key.includes('establishing')) return 'extreme_wide';
  if (key.includes('wide') || key.includes('full') || key.includes('long')) return 'wide';
  if (key.includes('medium') || key.includes('mid')) return 'medium';
  return DEFAULT_CAMERA_ANGLE;
}

/**
 * Normalizál egy kameramozgást a zárt szókészletre.
 * Ismeretlen érték esetén az alapértelmezettet adja vissza.
 */
export function normalizeCameraMovement(value: unknown): CameraMovement {
  if (isCameraMovement(value)) return value;
  if (typeof value !== 'string') return DEFAULT_CAMERA_MOVEMENT;
  const key = legacyKey(value);
  const direct = MOVEMENT_ALIASES[key];
  if (direct) return direct;
  // Tartalmi visszaesés: a kulcsszó alapján a legközelebbi zárt érték.
  if (key.includes('push') || key.includes('dolly') || key.includes('zoom')) return 'slow_push_in';
  if (key.includes('pan') || key.includes('track')) return 'slow_pan';
  if (key.includes('tilt')) return 'slow_tilt';
  if (key.includes('static') || key.includes('still') || key.includes('fixed')) return 'static';
  return DEFAULT_CAMERA_MOVEMENT;
}

/** Igaz, ha az érték érvényes beszédmód. */
export function isDialogueMode(value: unknown): value is DialogueMode {
  return typeof value === 'string' && (DIALOGUE_MODES as readonly string[]).includes(value);
}

/** A beszédmód normalizálása (értékelem → 'none'). */
export function normalizeDialogueMode(value: unknown): DialogueMode {
  return isDialogueMode(value) ? value : 'none';
}

/** Egy felvétel minimális adathalmaza a validáláshoz. */
export interface ShotRuleInput {
  action?: string | null;
  dialogue_hu?: string | null;
  dialogue_mode?: string | null;
  camera_angle?: string | null;
  camera_movement?: string | null;
  visual_prompt_en?: string | null;
  speaker_character_id?: string | null;
  featured_character_ids?: string[] | null;
}

/** A validálás kontextusa (a karakterek neve a 3. szabályhoz). */
export interface ShotRuleContext {
  /** A projekt karaktereinek nevei (a név szerinti előfordulás számolásához). */
  characterNames?: string[];
}

/** Egy szabályszámszerűsített probléma. */
export interface ShotViolation {
  /** Az írási szabály száma (1–5). */
  rule: number;
  /** Rövid, gépi kód. */
  code: string;
  /** Magyar javítóüzenet. */
  message: string;
}

/** Megszámolja a felvételben megnevezett karaktereket. */
export function countNamedCharacters(
  shot: ShotRuleInput,
  context: ShotRuleContext = {}
): number {
  const names = (context.characterNames ?? []).filter((n) => n && n.trim().length > 0);
  if (names.length === 0) return 0;
  const text = `${shot.action ?? ''} ${shot.visual_prompt_en ?? ''}`;
  let count = 0;
  for (const name of names) {
    if (containsPhrase(text, name.trim())) count += 1;
  }
  return count;
}

/** A beszélő karakterek száma (a "pontosan egy beszélő" feltételhez). */
export function countSpeakers(shot: ShotRuleInput): number {
  const ids = new Set<string>();
  if (shot.speaker_character_id && shot.speaker_character_id.trim()) {
    ids.add(shot.speaker_character_id.trim());
  }
  for (const id of shot.featured_character_ids ?? []) {
    if (id && id.trim()) ids.add(id.trim());
  }
  return ids.size;
}

/**
 * A determinisztikus validator: az 1–5. írási szabály ellenőrzése.
 * Nem dob kivételt, hanem a problémák listáját adja vissza.
 */
export function validateShot(
  shot: ShotRuleInput,
  context: ShotRuleContext = {}
): ShotViolation[] {
  const violations: ShotViolation[] = [];
  const angle = normalizeCameraAngle(shot.camera_angle);
  const movement = normalizeCameraMovement(shot.camera_movement);
  const dialogue = (shot.dialogue_hu ?? '').trim();
  const mode = normalizeDialogueMode(shot.dialogue_mode);
  const text = `${shot.action ?? ''} ${shot.visual_prompt_en ?? ''}`;

  // 1. Egyetlen folytonos cselekmény, egyetlen kameramozgás.
  for (const word of MULTI_BEAT_WORDS) {
    if (containsPhrase(text, word)) {
      violations.push({
        rule: 1,
        code: 'multi_beat',
        message: `A felvétel több ütemben zajló cselekményt tartalmaz ("${word}"). Egy felvétel = egy folytonos cselekmény.`,
      });
      break;
    }
  }

  // 2. Csoportos jelenet csak széles plánban.
  const isGroupScene = GROUP_SCENE_WORDS.some((word) => containsPhrase(text, word));
  if (isGroupScene && CLOSE_ANGLES.includes(angle)) {
    violations.push({
      rule: 2,
      code: 'group_scene_close',
      message:
        'Csoportos jelenet (tömeg, utca, háború, csoport) csak wide vagy extreme_wide plánban lehet.',
    });
  }

  // 3. Közeli plánban legfeljebb 2 megnevezett szereplő.
  const named = countNamedCharacters(shot, context);
  if (CLOSE_ANGLES.includes(angle) && named > 2) {
    violations.push({
      rule: 3,
      code: 'too_many_named_characters',
      message: `Közeli plánban legfeljebb 2 megnevezett szereplő lehet, a felvételben ${named} szerepel.`,
    });
  }

  // 4. Tiltott fő téma közeli plánban.
  if (angle === 'close_up' || angle === 'medium_close') {
    for (const subject of BANNED_CLOSE_SUBJECTS) {
      if (containsPhrase(text, subject)) {
        violations.push({
          rule: 4,
          code: 'banned_close_subject',
          message: `A felvétel fő témája nem lehet: "${subject}". Mutasd széles plánban, közvetítve vagy utólag.`,
        });
        break;
      }
    }
  }

  // 5. Kamerában látható beszéd feltételei.
  if (dialogue) {
    const speakers = countSpeakers(shot);
    if (mode === 'on_camera') {
      if (!SPEAKING_ANGLES.includes(angle)) {
        violations.push({
          rule: 5,
          code: 'on_camera_angle',
          message:
            'Kamerában látható beszéd csak medium_close vagy close_up plánban lehetséges. Más esetben legyen voice-over.',
        });
      }
      if (!SPEAKING_MOVEMENTS.includes(movement)) {
        violations.push({
          rule: 5,
          code: 'on_camera_movement',
          message:
            'Kamerában látható beszédnél csak static vagy slow_push_in kameramozgás lehetséges.',
        });
      }
      if (speakers !== 1) {
        violations.push({
          rule: 5,
          code: 'on_camera_speaker',
          message: 'Kamerában látható beszédhez pontosan egy beszélő szükséges.',
        });
      }
    } else if (mode === 'voice_over') {
      if (angle === 'close_up' || angle === 'medium_close') {
        violations.push({
          rule: 5,
          code: 'voice_over_close',
          message:
            'Voice-over beszédhez megfelelő vizuál kell (széles plán, környezet vagy hallgató), nem közeli arcplán.',
        });
      }
    } else {
      violations.push({
        rule: 5,
        code: 'dialogue_mode_missing',
        message: 'A párbeszédhez meg kell adni a beszédmódot: on_camera vagy voice_over.',
      });
    }
  } else if (mode !== 'none') {
    violations.push({
      rule: 5,
      code: 'dialogue_without_text',
      message: 'Párbeszéd nélküli felvételnél a beszédmód legyen none.',
    });
  }

  return violations;
}

/** A normalizálás eredménye. */
export interface NormalisedShot {
  camera_angle: CameraAngle;
  camera_movement: CameraMovement;
  dialogue_mode: DialogueMode;
  /** A kódban javított problémák magyar megjegyzései (a qc_notes-ba kerülnek). */
  notes: string[];
}

/**
 * Normalizálja a felvételt: a szókészleten kívüli értékeket javítja, és
 * rögzíti a megjegyzéseket. Nem dob kivételt, sosem állítja le a folyamatot.
 */
export function normaliseShot(
  shot: ShotRuleInput,
  context: ShotRuleContext = {}
): NormalisedShot {
  const notes: string[] = [];
  const dialogue = (shot.dialogue_hu ?? '').trim();

  const rawAngle = shot.camera_angle ?? null;
  const camera_angle = normalizeCameraAngle(rawAngle);
  if (rawAngle && !isCameraAngle(rawAngle)) {
    notes.push(
      `A kameraszög ("${rawAngle}") érvénytelen volt, zárt szókészletre normalizálva: ${camera_angle}.`
    );
  }

  const rawMovement = shot.camera_movement ?? null;
  const camera_movement = normalizeCameraMovement(rawMovement);
  if (rawMovement && !isCameraMovement(rawMovement)) {
    notes.push(
      `A kameramozgás ("${rawMovement}") érvénytelen volt, zárt szókészletre normalizálva: ${camera_movement}.`
    );
  }

  let dialogue_mode = normalizeDialogueMode(shot.dialogue_mode);
  if (!dialogue) {
    if (dialogue_mode !== 'none') {
      notes.push('Párbeszéd nélküli felvétel: a beszédmód none lett.');
    }
    dialogue_mode = 'none';
  } else if (dialogue_mode === 'none') {
    // A beszédmód hiányzott: a szabályokból levezetjük.
    const speakers = countSpeakers(shot);
    const eligible =
      SPEAKING_ANGLES.includes(camera_angle) &&
      SPEAKING_MOVEMENTS.includes(camera_movement) &&
      speakers === 1;
    dialogue_mode = eligible ? 'on_camera' : 'voice_over';
    notes.push(
      `A beszédmód hiányzott, a szabályok alapján beállítva: ${dialogue_mode}.`
    );
  } else if (dialogue_mode === 'on_camera') {
    const speakers = countSpeakers(shot);
    const eligible =
      SPEAKING_ANGLES.includes(camera_angle) &&
      SPEAKING_MOVEMENTS.includes(camera_movement) &&
      speakers === 1;
    if (!eligible) {
      dialogue_mode = 'voice_over';
      notes.push(
        'A kamerában látható beszéd nem felelt meg a szabályoknak, voice-over beszédként kezeljük.'
      );
    }
  }

  // A szabályok maradék problémái (pl. tiltott fő téma) megjegyzésként maradnak.
  for (const violation of validateShot(
    { ...shot, camera_angle, camera_movement, dialogue_mode },
    context
  )) {
    notes.push(violation.message);
  }

  return { camera_angle, camera_movement, dialogue_mode, notes };
}

/** A lip-sync előfeltételeit vizsgáló tiszta függvény. */
export interface LipsyncEligibilityShot {
  dialogue_hu?: string | null;
  camera_angle?: string | null;
  camera_movement?: string | null;
  speaker_character_id?: string | null;
  featured_character_ids?: string[] | null;
}

/**
 * Igaz, ha a felvétel ajakszinkronra alkalmas:
 * van beszéd, beszélő-közeli plán, engedélyezett mozgás, és pontosan egy beszélő.
 * Igény szerint számolva, nem tárolva.
 */
export function isLipsyncEligible(shot: LipsyncEligibilityShot): boolean {
  const dialogue = (shot.dialogue_hu ?? '').trim();
  if (!dialogue) return false;

  const angle = normalizeCameraAngle(shot.camera_angle);
  if (!SPEAKING_ANGLES.includes(angle)) return false;

  const movement = normalizeCameraMovement(shot.camera_movement);
  if (!SPEAKING_MOVEMENTS.includes(movement)) return false;

  return countSpeakers(shot) === 1;
}

/**
 * Az Agent 2 rendszerpromptjába beépülő rövid írási szabályok.
 * Egyetlen forrás: a prompt és a validator ugyanazt a szókészletet használja.
 */
export const AGENT2_SHOT_RULES: readonly string[] = [
  '1. Egy felvétel = egy folytonos cselekmény és egyetlen kameramozgás. Több ütemben zajló cselekményt ne írj le (nincs "then", "suddenly", "cut to").',
  '2. Tömeg, háború, utca, csoport: csak wide vagy extreme_wide plán; a tömeg távolról, anonim sziluettként (kis alakok) jelenik meg. Egy szereplőt csak akkor nevezz meg, ha ő a fő téma.',
  '3. Medium vagy közelebbi plánban legfeljebb 2 megnevezett szereplő lehet.',
  '4. Ne legyen a fő téma: olvasható szöveg/képernyő/tábla, finom kézimunka, két szereplő közötti szoros testi kontaktus. Ezeket széles plánban, közvetítve vagy utólag mutasd.',
  '5. Kamerában látható beszéd csak medium_close vagy close_up plánban, static vagy slow_push_in mozgással, pontosan egy beszélővel (arc takaratlan, a kamerához vagy háromnegyedben néz). Minden más beszéd voice-over legyen megfelelő vizuálra (széles plán, környezet, hallgató); a sor marad a dialogue_hu mezőben.',
  '6. A visual_prompt_en tartalmazza a kontinuitási attribútumokat (arc, haj, ruházat; helyszíni fény, légkör). Stílusjelölőt ne írj bele: azt az Agent 4 adja hozzá.',
];

/** A zárt szókészlet emberi olvasásra szánt leírása (a promptban). */
export const AGENT2_VOCABULARY_HINT = [
  `camera_angle ∈ {${CAMERA_ANGLES.join(', ')}}`,
  `camera_movement ∈ {${CAMERA_MOVEMENTS.join(', ')}}`,
].join('; ');
