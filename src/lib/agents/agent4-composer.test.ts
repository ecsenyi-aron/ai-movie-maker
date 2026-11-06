import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPOSER_CONFIG,
  FIXED_STYLE_MARKER,
  chooseReferenceForShot,
  composeCharacterReferencePrompt,
  composeLocationReferencePrompt,
  composeVideoPrompt,
  locationPromptHasNoPeople,
  planShotReferences,
  videoPromptIsClean,
} from './agent4-composer.ts';

test('minden kép prompt tartalmazza a FIXED STYLE MARKER-t', () => {
  const character = composeCharacterReferencePrompt({
    name: 'Anna',
    canonicalDescription: 'short dark hair, red coat',
  });
  const location = composeLocationReferencePrompt({
    name: 'Cafe',
    canonicalDescription: 'small wooden cafe interior',
    environmentalAttributes: 'warm afternoon light',
  });
  assert.ok(character.includes(FIXED_STYLE_MARKER));
  assert.ok(location.includes(FIXED_STYLE_MARKER));
  assert.equal(COMPOSER_CONFIG.styleMarker, FIXED_STYLE_MARKER);
});

test('karakter referencia: egy alany, semleges póz, egyszínű háttér, nincs szöveg/logó', () => {
  const prompt = composeCharacterReferencePrompt({
    name: 'Anna',
    canonicalDescription: 'short dark hair, red coat',
  });
  assert.ok(prompt.includes('single subject'));
  assert.ok(prompt.includes('neutral standing pose'));
  assert.ok(prompt.includes('facing camera or three-quarter view'));
  assert.ok(prompt.includes('plain solid-colour background'));
  assert.ok(prompt.includes('simple distinctive look'));
  assert.ok(prompt.includes('no text'));
  assert.ok(prompt.includes('no logo'));
  assert.ok(prompt.includes('short dark hair, red coat'));
});

test('karakter referencia: hiányzó leírásnál is érvényes prompt keletkezik', () => {
  const prompt = composeCharacterReferencePrompt({});
  assert.ok(prompt.includes('single subject'));
  assert.ok(prompt.includes(FIXED_STYLE_MARKER));
});

test('helyszín referencia: csak környezet, nincs ember, a légkör belekerül', () => {
  const prompt = composeLocationReferencePrompt({
    name: 'Cafe',
    canonicalDescription: 'small wooden cafe interior',
    environmentalAttributes: 'warm afternoon light, dust in the air',
  });
  assert.ok(prompt.includes('environment only'));
  assert.ok(prompt.includes('no people'));
  assert.ok(prompt.includes('warm afternoon light, dust in the air'));
  assert.ok(locationPromptHasNoPeople(prompt));
});

test('helyszín referencia: a saját tiltó szavak nem számítanak emberutalásnak', () => {
  const prompt = composeLocationReferencePrompt({ name: 'Street', canonicalDescription: 'empty street' });
  assert.ok(locationPromptHasNoPeople(prompt));
});

test('helyszín referencia: valódi emberutalás kiszűrődik', () => {
  assert.equal(locationPromptHasNoPeople('a crowded street with many people'), false);
  assert.equal(locationPromptHasNoPeople('a woman standing in the room'), false);
});

test('videó prompt: visual_prompt_en + camera_movement, stílusjelölés nélkül', () => {
  const prompt = composeVideoPrompt({
    visualPromptEn: 'Anna walks through the rainy street',
    cameraMovement: 'slow_pan',
  });
  assert.ok(prompt.includes('Anna walks through the rainy street'));
  assert.ok(prompt.includes('camera movement: slow_pan'));
  assert.ok(videoPromptIsClean(prompt));
  assert.equal(prompt.includes(FIXED_STYLE_MARKER), false);
});

test('videó prompt: üres adatoknál is stabil (üres string)', () => {
  assert.equal(composeVideoPrompt({}), '');
  assert.ok(videoPromptIsClean(''));
});

test('referencia-választás: pontosan egy főszereplő -> karakter', () => {
  const choice = chooseReferenceForShot({
    featuredCharacterIds: ['c1'],
    characters: [
      { id: 'c1', name: 'Anna' },
      { id: 'c2', name: 'Bela' },
    ],
    location: { id: 'l1', name: 'Cafe' },
  });
  assert.equal(choice.kind, 'character');
  if (choice.kind === 'character') assert.equal(choice.character.id, 'c1');
});

test('referencia-választás: több főszereplő -> nincs referencia', () => {
  const choice = chooseReferenceForShot({
    featuredCharacterIds: ['c1', 'c2'],
    characters: [{ id: 'c1' }, { id: 'c2' }],
    location: { id: 'l1' },
  });
  assert.equal(choice.kind, 'none');
});

test('referencia-választás: főszereplő nélkül -> helyszín', () => {
  const choice = chooseReferenceForShot({
    featuredCharacterIds: [],
    characters: [{ id: 'c1' }],
    location: { id: 'l1', name: 'Cafe' },
  });
  assert.equal(choice.kind, 'location');
  if (choice.kind === 'location') assert.equal(choice.location.id, 'l1');
});

test('referencia-választás: főszereplő nélkül, de egy beszélővel -> a beszélő karaktere', () => {
  const choice = chooseReferenceForShot({
    featuredCharacterIds: [],
    speakerCharacterId: 'c2',
    characters: [{ id: 'c1' }, { id: 'c2' }],
    location: { id: 'l1' },
  });
  assert.equal(choice.kind, 'character');
  if (choice.kind === 'character') assert.equal(choice.character.id, 'c2');
});

test('referencia-választás: semmi sem érhető el -> none', () => {
  const choice = chooseReferenceForShot({});
  assert.equal(choice.kind, 'none');
});

// ---------------------------------------------------------------------------
// Multi-reference terv (`elements` tömb)
// ---------------------------------------------------------------------------

test('referencia-terv: egy főszereplő -> csak a fő referencia', () => {
  const plan = planShotReferences({
    featuredCharacterIds: ['c1'],
    characters: [{ id: 'c1' }, { id: 'c2' }],
    location: { id: 'l1' },
  });
  assert.deepEqual(plan.primary, { kind: 'character', id: 'c1' });
  // A helyszín is bekerül a további referenciák közé.
  assert.deepEqual(plan.additional, [{ kind: 'location', id: 'l1' }]);
  assert.equal(plan.reason, null);
});

test('referencia-terv: több főszereplő -> az első a fő, a többi az `elements` tömbbe', () => {
  const plan = planShotReferences({
    featuredCharacterIds: ['c1', 'c2'],
    characters: [{ id: 'c1' }, { id: 'c2' }],
    location: { id: 'l1' },
  });
  assert.deepEqual(plan.primary, { kind: 'character', id: 'c1' });
  assert.deepEqual(plan.additional, [
    { kind: 'character', id: 'c2' },
    { kind: 'location', id: 'l1' },
  ]);
});

test('referencia-terv: nincs főszereplő, de van beszélő -> a beszélő a fő referencia', () => {
  const plan = planShotReferences({
    featuredCharacterIds: [],
    speakerCharacterId: 'c2',
    characters: [{ id: 'c1' }, { id: 'c2' }],
    location: { id: 'l1' },
  });
  assert.deepEqual(plan.primary, { kind: 'character', id: 'c2' });
  assert.deepEqual(plan.additional, [{ kind: 'location', id: 'l1' }]);
});

test('referencia-terv: csak helyszín -> a helyszín a fő referencia', () => {
  const plan = planShotReferences({
    featuredCharacterIds: [],
    characters: [],
    location: { id: 'l1' },
  });
  assert.deepEqual(plan.primary, { kind: 'location', id: 'l1' });
  assert.deepEqual(plan.additional, []);
});

test('referencia-terv: semmi sem érhető el -> nincs terv', () => {
  const plan = planShotReferences({});
  assert.equal(plan.primary, null);
  assert.deepEqual(plan.additional, []);
  assert.ok(plan.reason);
});

test('videó prompt: az elem hivatkozások (@Element1) bekerülnek', () => {
  const prompt = composeVideoPrompt({
    visualPromptEn: 'Anna walks through the rainy street',
    cameraMovement: 'slow_pan',
    elementReferences: ['@Element1', '@Element2'],
  });
  assert.ok(prompt.includes('featuring @Element1 @Element2'));
  assert.ok(videoPromptIsClean(prompt));
});

test('videó prompt: elem hivatkozás nélkül nincs kiegészítés', () => {
  const prompt = composeVideoPrompt({
    visualPromptEn: 'Anna walks through the rainy street',
    elementReferences: [],
  });
  assert.ok(!prompt.includes('@Element'));
  assert.ok(!prompt.includes('featuring'));
});

