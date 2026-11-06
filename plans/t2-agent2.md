# T2 — AGENT 2 FELVÉTELTERVEZÉS (agent2-rules.ts, gemini.ts)
Előfeltétel: a t1 kész. Olvasd el a plans/t0-common.md-t, és tartsd be a szabályait. Egy válaszban egy részfeladat.
A sorrend: először a meglévő szabályok javítása (2A), utána az új funkciók, mert a 2A hibái fölösleges Gemini-javítást indítanak.

## 2A. A meglévő szabályok javítása (agent2-rules.ts, gemini.ts)
- 3. szabály új szövege: "3. Közeli (medium vagy közelebbi) plánban legfeljebb 2 szereplő arca látszódjon azonosíthatóan; ők szerepeljenek a featured_character_ids-ben. Harmadik szereplő csak elmosódott háttérben, hátulról vagy a kép szélén (vállkép) jelenhet meg, és ne nevezd meg. Három szereplős pillanathoz használj wide plánt, vagy bontsd több felvételre (egy-egy szereplő, majd reakció)."
- Validátor a 3. szabályhoz: elsődlegesen a featured_character_ids egyedi elemeit számolja (a speaker_character_id-val együtt). A névkeresés csak a visual_prompt_en-re maradjon. A magyar action mezőben a ragozott nevek ("Annát") a szóhatáros keresésen úgysem egyeznek.
- 4. szabály új szövege: "4. Közeli plánban (medium_close, close_up) ne legyen a felvétel fő témája: (a) olvasható szöveg, tábla, képernyő, levél; (b) finom kézmunka (írás, gépelés, apró tárgyak ujjal); (c) két szereplő szoros testi kontaktusa (csók, ölelés, kézfogás, dulakodás). Az esemény ettől még megtörténik: mutasd széles plánban sziluettként, a másik szereplő reakcióján, az előtte és utána képeken, vagy hangban (voice_over). Szöveget ne kérj a képen: a tartalmát mondd el mondatban vagy voice-overben." A BANNED_CLOSE_SUBJECTS listát egészítsd ki ragozatlan alakokkal: kiss, kisses, hug, hugs, handshake.
- GROUP_SCENE_WORDS szűkítése: maradjon crowd, crowds, crowded, mob, army, battle, riot, protest, audience, group of people, groups of people, tömeg, csata, tüntetés. TÖRÖLD: group, groups, war, street, streets, market, people, csoport, utca, háború (pl. "empty street at night" vagy "two people talking" nem csoportjelenet).
- Magyar szavak ragozása: a magyar szavakat (tömeg, csata, tüntetés) töredékes egyezéssel (substring) keresd, külön listából, mert a containsPhrase szóhatára elbukik a "tömegben" alakon.
- Hiba a countSpeakers-ben: a speaker_character_id és a featured_character_ids unióját számolja, ezért egy vállkép, ahol a hallgató is szerepel, 2 beszélőnek látszik: az 5. szabály hamis on_camera_speaker hibát ad, ami fölösleges javítási Gemini-hívást indít. Új szabály: on_camera esetén kell speaker_character_id, és a featured_character_ids-ben (ha nem üres) csak a beszélő lehet. A hallgató hátulról/elmosva szerepel a visual_prompt_en-ben, névtelenül. Írd át ehhez a countSpeakers használatait, a normaliseShot-ot és az isLipsyncEligible-t, és az 5. szabály szövegében csak ezt az egy mondatot pontosítsd ("ő az egyetlen azonosítható arc; a hallgató legfeljebb hátulról vagy elmosva").
Tesztek (agent2-rules.test.ts): "empty street" + close_up → nincs 2. szabály hiba; "crowd" + close_up → hiba; "tömegben" + close_up → hiba; 3. szabály a featured_character_ids alapján; vállkép (beszélő + névtelen hallgató) → nincs on_camera_speaker hiba. Futtasd a teszteket. Állj meg és jelents.

## 2B. Átadás az Agent 2-nek (gemini.ts)
- A briefContextBlock kapja meg a logline, central_conflict, conflicts, turning_point mezőket is. A jelenetek JSON-ja az új mezőkkel együtt menjen az agent2Prompt-ba.
- Teszteld egy tiszta függvénnyel (exportáld a prompt-építőt), hogy egy új mező megjelenik a promptban.
A prompt-építő kerüljön külön tiszta modulba (pl. agent2-prompt.ts), hogy a teszt ne importálja a gemini.ts-t (az importáláskor klienst hoz létre). A gemini.ts importálja onnan.

## 2C. Új felvétel-mezők (agent2Schema, Agent2Output, normalizáló)
- SHOT_FUNCTIONS = ['establishing','action','dialogue','reaction','insert','hold']
- PACES = ['slow','normal','fast']
- CUT_REASONS = ['establish','emotional_change','new_information','speaker_change','tension_peak','release','scene_end']
- LINE_TIMINGS = ['before_line','with_line','after_line']
- MUSIC_CUES = ['none','build','accent','drop_out']
- Mezők: shot_function, intensity (1–5), pace, cut_reason, cut_note (1 rövid magyar mondat: miért itt vágunk), line_timing, pre_roll_sec és post_hold_sec (0–3 mp), music_cue.
- PACE_DURATION KIINDULÓ ÉRTÉK: slow 5–8 mp, normal 3,5–5 mp, fast 2–3,5 mp. A target_duration_sec-t a normalizáló a pace tartományába igazítja, és megjegyzést ír. Ne tegyél fel ismeretlen videómodell-korlátot.
a) Az igazítás csak párbeszéd nélküli felvételre vonatkozik. Ahol van dialogue_hu, az Agent 3 a hangból zárolja a hosszt: ott a pace-tartományból kilógó hossz csak megjegyzést kap.
b) A pace és az intensity a sémában opcionális: ha a modell nem adja meg, a kód számolja az E6 szerint a jelenet tension_level-jéből (hold felvételnél pace = slow). A sémában csak a shot_function legyen required az új mezők közül, a többi opcionális. Ok: kisebb kimenet, kisebb csonkolási kockázat.
Állj meg és jelents.

## 2D. Vágási szabályok (agent2-rules.ts, gemini.ts)
Exportálj AGENT2_EDITING_RULES tömböt, és építsd be az agent2RulesBlock-ba az 1–6. szabály után:
- E1 Establishing: a film első jelenetének és minden helyszínváltásnak az első felvétele establishing, wide vagy extreme_wide, beszéd nélkül. Folytatólagos helyszínnél kihagyható.
- E2 Ne vágj minden mondatnál. Az azonos beszélő egymás utáni mondatai egy felvételben maradnak. Beszélőváltásnál csak akkor új felvétel, ha a cut_reason indokolja (érzelmi változás, új információ, feszültségcsúcs); egyébként marad a kép.
- E3 Reakciófelvétel (reaction): a hallgató arca, beszéd nélkül, ha számára új információ vagy érzelmi változás hangzik el, vagy a fordulat/csúcs következik. Nem minden mondat után. dialogue módú jelenetben tension_level ≥ 3 esetén legalább egy; a turn jelenetben kötelező.
- E4 Dialógushoz vágás (line_timing): before_line = a kép már a mondat előtt látszik (kivárás, csend, pre_roll_sec > 0); with_line; after_line = a súlyos mondat után a kép marad (post_hold_sec > 0).
- E5 Csend és hold: a csúcs vagy a fordulat után egy hosszabb, beszéd nélküli hold felvétel (pace = slow, static vagy slow_push_in). A csend dramaturgiai elem.
- E6 Ritmus: tension_level 1–2 → slow, 3 → normal, 4–5 → fast. Egy jelenetben a feszültség növekedésével a felvételek fokozatosan rövidülnek; a hold a kivétel. A felvétel intensity-je a jelenet feszültségétől legfeljebb ±1-gyel térjen el.
- E7 Közelkép (close_up, medium_close): érzelmi csúcsra, új információra vagy a karakter trait_in_action pillanatára. Új helyszínű jelenet nem indul közelivel.
- E8 Az Agent 1 követése: minden jelenet scene_event-je és information_reveal-ja látszik legalább egy felvétel action mezőjében; a karakter trait_in_action-je legalább egyszer megjelenik.
- E9 music_cue csak JELÖLÉS. Nincs zenemodul: a UI ne állítsa, hogy a vágás zenéhez igazított.
Az E3 "turn jelenetben kötelező" szabály 2 jeleneteknél a climax jelenetre vonatkozzon, mert ott a fordulat a climax jelenetben van (lásd t1/1C).
Állj meg és jelents.

## 2E. Determinisztikus ellenőrzés: validateSceneEditing(shots, sceneInfo)
Csak megjegyzést ad (qc_notes), javítási hívást nem indít. Jelezze:
- hiányzó establishing helyszínváltásnál vagy az első jelenetben;
- dialogue jelenet tension_level ≥ 3 reakciófelvétel nélkül;
- turn jelenet reakció és hold nélkül;
- 3-nál több egymást követő beszélős felvétel reakció vagy hold nélkül;
- ≥4 felvételes, növekvő feszültségű jelenetben az utolsó fele nem rövidebb, mint az első;
- közeli felvétellel induló új helyszínű jelenet;
- pre_roll_sec / post_hold_sec / intensity tartományon kívül (szorítsd be).
Plusz megjegyzés: ha egy felvétel hossza egy hangolható MAX_SHOT_SECONDS_HINT konstans fölé kerül (KIINDULÓ érték, a videómodell hosszkorlátja nincs ellenőrizve). A hosszú, azonos beszélős felvételeknél (E2) ez figyelmeztet.

## 2F. Maradék tesztek és futtatás
- agent2-rules.test.ts: validateSceneEditing esetek (2E lista); PACE_DURATION igazítás (párbeszéd nélküli felvétel igazodik; párbeszédes csak megjegyzést kap); a hiányzó pace/intensity a kódból jön; régi sor (új mezők nélkül) nem dob hibát.
- Prompt-építő teszt (2B).
- Futtasd a teljes tesztet és a TypeScript-ellenőrzést (tsc --noEmit vagy a projekt saját parancsa). Állj meg és jelents.