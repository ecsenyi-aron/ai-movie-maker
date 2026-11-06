import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VISUAL_STYLES,
  STYLE_MARKERS,
  getStyleMarker,
  normaliseBrief,
  slugifyId,
} from './agent1-brief.ts';

const goodScene = { title: 'A', description: 'd', time_of_day: 'Nappal', setting: 'Utca' };

test('érvényes zárt értékek megmaradnak', () => {
  const { brief, notes } = normaliseBrief({
    title: 'Teszt',
    input_type: 'script',
    genre: 'fantasy',
    visual_style: 'anime',
    length_class: 'short',
    scenes: [goodScene, goodScene, goodScene],
  });
  assert.equal(brief.genre, 'fantasy');
  assert.equal(brief.visual_style, 'anime');
  assert.equal(brief.input_type, 'script');
  assert.equal(brief.length_class, 'short');
  assert.equal(notes.length, 0);
});

test('érvénytelen vagy hiányzó zárt érték alapértelmezettre cserélődik és megjegyzés készül', () => {
  const { brief, notes } = normaliseBrief({
    genre: 'musical',
    visual_style: 'photo',
    scenes: [goodScene, goodScene],
  });
  assert.equal(brief.genre, 'drama');
  assert.equal(brief.visual_style, 'cinematic_realistic');
  assert.equal(brief.length_class, 'short_test');
  assert.equal(brief.input_type, 'idea');
  assert.ok(notes.length >= 3);
  assert.ok(brief.assumptions?.some((a) => a.includes('A műfaj')));
});

test('nyers null vagy nem objektum bemenet sem dob kivételt', () => {
  assert.equal(normaliseBrief(null).brief.title, 'Névtelen film');
  assert.equal(normaliseBrief('szöveg').brief.scenes.length, 0);
});

test('szereplők: hiányzó azonosító generálódik, a duplikált eldobódik, a név nélküli kimarad', () => {
  const { brief } = normaliseBrief({
    scenes: [goodScene, goodScene],
    characters: [
      { name: 'Édes Anna', role: 'fő', look: 'young woman' },
      { stable_id: 'char_bela', name: 'Béla', role: 'mellék', look: 'old man' },
      { stable_id: 'char_bela', name: 'Béla másodszor', role: '', look: '' },
      { role: 'név nélkül' },
    ],
  });
  assert.deepEqual(
    brief.characters?.map((c) => c.stable_id),
    ['char_edes_anna', 'char_bela']
  );
});

test('a jelenetek 1-től folytonosan újraszámozódnak, a darabszámot a szerver számolja', () => {
  const { brief } = normaliseBrief({
    length_class: 'short',
    scenes: [
      { ...goodScene, number: 5 },
      { ...goodScene, number: 5 },
      { ...goodScene, number: 9 },
    ],
    estimated_scenes_count: 99,
  });
  assert.deepEqual(
    brief.scenes.map((s) => s.number),
    [1, 2, 3]
  );
  assert.equal(brief.estimated_scenes_count, 3);
});

test('a hosszhoz képest szokatlan jelenetszám megjegyzést kap, de nem hiba', () => {
  const { brief, notes } = normaliseBrief({
    length_class: 'short_test',
    scenes: [goodScene, goodScene, goodScene, goodScene, goodScene],
  });
  assert.equal(brief.scenes.length, 5);
  assert.ok(notes.some((n) => n.includes('eltér')));
});

test('minden stílushoz van stílusjelölő, ismeretlen stílusnál az alapértelmezett jön', () => {
  for (const style of VISUAL_STYLES) {
    assert.ok(STYLE_MARKERS[style].length > 0);
    assert.equal(getStyleMarker(style), STYLE_MARKERS[style]);
  }
  assert.equal(getStyleMarker('ismeretlen'), STYLE_MARKERS.cinematic_realistic);
});

test('slugifyId kezeli az ékezeteket és a szóközöket', () => {
  assert.equal(slugifyId('loc', 'Régi kávéház'), 'loc_regi_kavehaz');
  assert.equal(slugifyId('char', '!!!'), 'char_x');
});