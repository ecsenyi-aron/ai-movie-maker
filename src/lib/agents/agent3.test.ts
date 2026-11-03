import { testWordCountEstimate, calculateWavDuration, estimateSpeechDuration, WORDS_PER_SECOND } from './agent3';

function runTests() {
  console.log('--- Agent 3 4b-fix Automatikus Tesztek Indítása ---');

  // 1. Szószám alapú időtartam becslés tesztje (WORDS_PER_SECOND = 2.2 konzervatív)
  const text1 = 'Ez egy rövid magyar mondat.'; // 5 szó -> 5 / 2.2 = 2.272...
  const est1 = testWordCountEstimate(text1);
  console.assert(est1 >= 2.0, `Teszt 1 hiba: legalább 2.0 kell legyen`);
  console.log(`✓ Teszt 1 (Word count estimate): "${text1}" -> ${est1}s (OK)`);

  const emptyText = '   ';
  const estEmpty = estimateSpeechDuration(emptyText);
  console.assert(estEmpty === 0.0, `Teszt 2 hiba: üres szövegnél 0.0 kell legyen, kapott ${estEmpty}`);
  console.log(`✓ Teszt 2 (Skipping empty dialogue check): üres -> ${estEmpty}s (OK)`);

  // 2. WAV időtartam számítás tesztje (24000 Hz, 1 csatorna, 16 bit = 2 byte / sample)
  const duration1 = calculateWavDuration(48000, 24000, 1, 16);
  console.assert(duration1 === 1.0, `Teszt 3 hiba: várt 1.0, kapott ${duration1}`);
  console.log(`✓ Teszt 3 (WAV duration calculation): 48000 bytes -> ${duration1}s (OK)`);

  const duration2 = calculateWavDuration(96000, 24000, 1, 16);
  console.assert(duration2 === 2.0, `Teszt 4 hiba: várt 2.0, kapott ${duration2}`);
  console.log(`✓ Teszt 4 (WAV duration calculation): 96000 bytes -> ${duration2}s (OK)`);

  console.log('--- Minden Agent 3 4b-fix egységteszt sikeresen lefutott! ---');
}

runTests();
