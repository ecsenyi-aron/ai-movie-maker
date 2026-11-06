import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAMERA_ANGLES,
  CAMERA_MOVEMENTS,
  DIALOGUE_MODES,
  isCameraAngle,
  isCameraMovement,
  isDialogueMode,
  normalizeCameraAngle,
  normalizeCameraMovement,
  normalizeDialogueMode,
  validateShot,
  normaliseShot,
  isLipsyncEligible,
  countNamedCharacters,
  countSpeakers,
  AGENT2_SHOT_RULES,
  AGENT2_VOCABULARY_HINT,
} from './agent2-rules.ts';

// ---------------------------------------------------------------------------
// Zárt szókészletek
// ---------------------------------------------------------------------------

test('zárt szókészlet: a kameraszögek pontosan az öt engedélyezett érték', () => {
  assert.deepEqual([...CAMERA_ANGLES], [
    'extreme_wide',
    'wide',
    'medium',
    'medium_close',
    'close_up',
  ]);
  for (const angle of CAMERA_ANGLES) {
    assert.equal(isCameraAngle(angle), true, `${angle} elfogadandó`);
  }
  assert.equal(isCameraAngle('pl. close-up'), false);
  assert.equal(isCameraAngle('medium close'), false);
  assert.equal(isCameraAngle(''), false);
  assert.equal(isCameraAngle(null), false);
  assert.equal(isCameraAngle(42), false);
});

test('zárt szókészlet: a kameramozgások pontosan a négy engedélyezett érték', () => {
  assert.deepEqual([...CAMERA_MOVEMENTS], ['static', 'slow_push_in', 'slow_pan', 'slow_tilt']);
  for (const movement of CAMERA_MOVEMENTS) {
    assert.equal(isCameraMovement(movement), true, `${movement} elfogadandó`);
  }
  assert.equal(isCameraMovement('pl. pan left'), false);
  assert.equal(isCameraMovement('zoom in'), false);
  assert.equal(isCameraMovement(undefined), false);
});

test('zárt szókészlet: a beszédmódok pontosan a három engedélyezett érték', () => {
  assert.deepEqual([...DIALOGUE_MODES], ['on_camera', 'voice_over', 'none']);
  assert.equal(isDialogueMode('on_camera'), true);
  assert.equal(isDialogueMode('voice-over'), false);
  assert.equal(normalizeDialogueMode('voice-over'), 'none');
  assert.equal(normalizeDialogueMode('on_camera'), 'on_camera');
});

// ---------------------------------------------------------------------------
// Legacy értékek normalizálása (a régi sorok nem íródnak át)
// ---------------------------------------------------------------------------

test('normalizálás: a legacy szabad szöveges kameraszögek a zárt szókészletre esnek', () => {
  assert.equal(normalizeCameraAngle('pl. close-up'), 'close_up');
  assert.equal(normalizeCameraAngle('Close Up'), 'close_up');
  assert.equal(normalizeCameraAngle('medium close-up'), 'medium_close');
  assert.equal(normalizeCameraAngle('pl. wide'), 'wide');
  assert.equal(normalizeCameraAngle('establishing'), 'extreme_wide');
  assert.equal(normalizeCameraAngle('medium'), 'medium');
});

test('normalizálás: a legacy kameramozgások a zárt szókészletre esnek', () => {
  assert.equal(normalizeCameraMovement('pl. pan left'), 'slow_pan');
  assert.equal(normalizeCameraMovement('static'), 'static');
  assert.equal(normalizeCameraMovement('push in'), 'slow_push_in');
  assert.equal(normalizeCameraMovement('tilt up'), 'slow_tilt');
});

test('normalizálás: ismeretlen érték esetén az alapértelmezett jön (nem dob kivételt)', () => {
  assert.equal(normalizeCameraAngle('valami furcsa'), 'medium');
  assert.equal(normalizeCameraMovement('valami furcsa'), 'static');
  assert.equal(normalizeCameraAngle(null), 'medium');
  assert.equal(normalizeCameraMovement(undefined), 'static');
});

// ---------------------------------------------------------------------------
// Validator: az 1–5. írási szabály
// ---------------------------------------------------------------------------

test('validator: a szabályokat követő felvétel hibátlan', () => {
  const violations = validateShot(
    {
      action: 'Anna lassan a pult felé lép.',
      dialogue_hu: 'Megállok itt.',
      dialogue_mode: 'on_camera',
      camera_angle: 'medium_close',
      camera_movement: 'static',
      visual_prompt_en: 'Anna at the counter, plain background.',
      speaker_character_id: 'char_anna',
      featured_character_ids: ['char_anna'],
    },
    { characterNames: ['Anna', 'Béla'] }
  );
  assert.deepEqual(violations, []);
});

test('validator: 1. szabály — több ütemben zajló cselekmény', () => {
  const violations = validateShot({
    action: 'Anna feláll, then kimegy az ajtón.',
    camera_angle: 'wide',
    camera_movement: 'static',
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 1);
  assert.equal(violations[0].code, 'multi_beat');
});

test('validator: 2. szabály — csoportos jelenet nem lehet közeli plánban', () => {
  const violations = validateShot({
    action: 'A tömeg a téren gyülekezik.',
    camera_angle: 'medium',
    camera_movement: 'static',
  });
  assert.equal(violations.some((v) => v.rule === 2 && v.code === 'group_scene_close'), true);

  const ok = validateShot({
    action: 'A tömeg a téren gyülekezik.',
    camera_angle: 'wide',
    camera_movement: 'static',
  });
  assert.equal(ok.some((v) => v.rule === 2), false);
});

test('validator: 3. szabály — közeli plánban legfeljebb 2 megnevezett szereplő', () => {
  const violations = validateShot(
    {
      action: 'Anna, Béla és Dénes beszélgetnek.',
      camera_angle: 'medium',
      camera_movement: 'static',
    },
    { characterNames: ['Anna', 'Béla', 'Dénes'] }
  );
  assert.equal(violations.some((v) => v.rule === 3 && v.code === 'too_many_named_characters'), true);
});

test('validator: 4. szabály — olvasható szöveg nem lehet a fő téma közeli plánban', () => {
  const violations = validateShot({
    action: 'A táblán olvasható szöveg látszik.',
    camera_angle: 'close_up',
    camera_movement: 'static',
  });
  assert.equal(violations.some((v) => v.rule === 4 && v.code === 'banned_close_subject'), true);

  const wide = validateShot({
    action: 'A táblán olvasható szöveg látszik.',
    camera_angle: 'wide',
    camera_movement: 'static',
  });
  assert.equal(wide.some((v) => v.rule === 4), false);
});

test('validator: 5. szabály — kamerában látható beszéd feltételei', () => {
  const wrongAngle = validateShot({
    dialogue_hu: 'Szólok.',
    dialogue_mode: 'on_camera',
    camera_angle: 'wide',
    camera_movement: 'static',
    speaker_character_id: 'char_anna',
  });
  assert.equal(wrongAngle.some((v) => v.code === 'on_camera_angle'), true);

  const wrongMovement = validateShot({
    dialogue_hu: 'Szólok.',
    dialogue_mode: 'on_camera',
    camera_angle: 'close_up',
    camera_movement: 'slow_pan',
    speaker_character_id: 'char_anna',
  });
  assert.equal(wrongMovement.some((v) => v.code === 'on_camera_movement'), true);

  const twoSpeakers = validateShot({
    dialogue_hu: 'Szólok.',
    dialogue_mode: 'on_camera',
    camera_angle: 'close_up',
    camera_movement: 'static',
    speaker_character_id: 'char_anna',
    featured_character_ids: ['char_anna', 'char_bela'],
  });
  assert.equal(twoSpeakers.some((v) => v.code === 'on_camera_speaker'), true);
});

test('validator: 5. szabály — beszédmód hiányzik, ha van párbeszéd', () => {
  const violations = validateShot({
    dialogue_hu: 'Szólok.',
    camera_angle: 'close_up',
    camera_movement: 'static',
    speaker_character_id: 'char_anna',
  });
  assert.equal(violations.some((v) => v.code === 'dialogue_mode_missing'), true);
});

test('validator: nem dob kivételt érvénytelen bemenetre', () => {
  const violations = validateShot({});
  assert.ok(Array.isArray(violations));
});

// ---------------------------------------------------------------------------
// Normalizálás (a javítási útvonal után a maradék problémát a kód rendezi)
// ---------------------------------------------------------------------------

test('normalizálás: az érvénytelen szókészleti értékeket javítja és megjegyzi', () => {
  const result = normaliseShot({
    camera_angle: 'pl. close-up',
    camera_movement: 'pl. pan left',
  });
  assert.equal(result.camera_angle, 'close_up');
  assert.equal(result.camera_movement, 'slow_pan');
  assert.equal(result.notes.length >= 2, true);
});

test('normalizálás: a hiányzó beszédmódot a szabályokból levezeti', () => {
  const onCamera = normaliseShot({
    dialogue_hu: 'Szólok.',
    camera_angle: 'close_up',
    camera_movement: 'static',
    speaker_character_id: 'char_anna',
  });
  assert.equal(onCamera.dialogue_mode, 'on_camera');

  const voiceOver = normaliseShot({
    dialogue_hu: 'Szólok.',
    camera_angle: 'wide',
    camera_movement: 'static',
    speaker_character_id: 'char_anna',
  });
  assert.equal(voiceOver.dialogue_mode, 'voice_over');
});

test('normalizálás: a nem megfelelő on_camera beszéd voice-over lesz', () => {
  const result = normaliseShot({
    dialogue_hu: 'Szólok.',
    dialogue_mode: 'on_camera',
    camera_angle: 'wide',
    camera_movement: 'slow_pan',
    speaker_character_id: 'char_anna',
  });
  assert.equal(result.dialogue_mode, 'voice_over');
  assert.equal(result.notes.length > 0, true);
});

test('normalizálás: a maradék szabályprobléma is megjegyzésként kerül ki', () => {
  const result = normaliseShot({
    action: 'A tömeg a téren gyülekezik.',
    camera_angle: 'medium',
    camera_movement: 'static',
  });
  assert.equal(result.notes.some((n) => n.includes('tömeg')), true);
});

// ---------------------------------------------------------------------------
// Számoló segédek
// ---------------------------------------------------------------------------

test('számoló segédek: megnevezett karakterek és beszélők száma', () => {
  const named = countNamedCharacters(
    { action: 'Anna és Béla áll a téren.' },
    { characterNames: ['Anna', 'Béla', 'Dénes'] }
  );
  assert.equal(named, 2);

  assert.equal(countSpeakers({ speaker_character_id: 'char_anna' }), 1);
  assert.equal(
    countSpeakers({ speaker_character_id: 'char_anna', featured_character_ids: ['char_anna'] }),
    1
  );
  assert.equal(
    countSpeakers({ speaker_character_id: 'char_anna', featured_character_ids: ['char_bela'] }),
    2
  );
  assert.equal(countSpeakers({}), 0);
});

// ---------------------------------------------------------------------------
// isLipsyncEligible — a lip-sync előfeltétele, igény szerint számolva
// ---------------------------------------------------------------------------

test('isLipsyncEligible: csak beszélő-közeli, egy beszélős, beszédes felvétel alkalmas', () => {
  assert.equal(
    isLipsyncEligible({
      dialogue_hu: 'Szólok.',
      camera_angle: 'close_up',
      camera_movement: 'static',
      speaker_character_id: 'char_anna',
    }),
    true
  );
  assert.equal(
    isLipsyncEligible({
      dialogue_hu: 'Szólok.',
      camera_angle: 'medium_close',
      camera_movement: 'slow_push_in',
      speaker_character_id: 'char_anna',
    }),
    true
  );
});

test('isLipsyncEligible: a negatív esetek nem alkalmasak', () => {
  // nincs beszéd
  assert.equal(
    isLipsyncEligible({
      camera_angle: 'close_up',
      camera_movement: 'static',
      speaker_character_id: 'char_anna',
    }),
    false
  );
  // nem beszélő-közeli plán
  assert.equal(
    isLipsyncEligible({
      dialogue_hu: 'Szólok.',
      camera_angle: 'wide',
      camera_movement: 'static',
      speaker_character_id: 'char_anna',
    }),
    false
  );
  // nem engedélyezett mozgás
  assert.equal(
    isLipsyncEligible({
      dialogue_hu: 'Szólok.',
      camera_angle: 'close_up',
      camera_movement: 'slow_pan',
      speaker_character_id: 'char_anna',
    }),
    false
  );
  // nincs beszélő
  assert.equal(
    isLipsyncEligible({
      dialogue_hu: 'Szólok.',
      camera_angle: 'close_up',
      camera_movement: 'static',
    }),
    false
  );
  // több beszélő
  assert.equal(
    isLipsyncEligible({
      dialogue_hu: 'Szólok.',
      camera_angle: 'close_up',
      camera_movement: 'static',
      speaker_character_id: 'char_anna',
      featured_character_ids: ['char_anna', 'char_bela'],
    }),
    false
  );
});

test('isLipsyncEligible: a legacy értékeket normalizálva számol', () => {
  assert.equal(
    isLipsyncEligible({
      dialogue_hu: 'Szólok.',
      camera_angle: 'pl. close-up',
      camera_movement: 'static',
      speaker_character_id: 'char_anna',
    }),
    true
  );
});

// ---------------------------------------------------------------------------
// A prompt blokk
// ---------------------------------------------------------------------------

test('prompt blokk: hat írási szabály és a zárt szókészlet szerepel benne', () => {
  assert.equal(AGENT2_SHOT_RULES.length, 6);
  for (const rule of AGENT2_SHOT_RULES) {
    assert.match(rule, /^\d+\./);
  }
  assert.equal(AGENT2_VOCABULARY_HINT.includes('camera_angle'), true);
  assert.equal(AGENT2_VOCABULARY_HINT.includes('camera_movement'), true);
  for (const angle of CAMERA_ANGLES) {
    assert.equal(AGENT2_VOCABULARY_HINT.includes(angle), true);
  }
  for (const movement of CAMERA_MOVEMENTS) {
    assert.equal(AGENT2_VOCABULARY_HINT.includes(movement), true);
  }
});
