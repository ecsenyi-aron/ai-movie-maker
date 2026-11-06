# T1 — AGENT 1 DRAMATURGIA (agent1-brief.ts, gemini.ts)
Előfeltétel: a t0 kész. Olvasd el a plans/t0-common.md-t, és tartsd be a szabályait. Egy válaszban egy részfeladat.

## 1A. Új mezők és típusok (agent1-brief.ts, agent1Schema)
Zárt listák és típusok a fájl tetején:
- DRAMATIC_FUNCTIONS = ['setup','conflict','escalation','turn','climax','resolution']
- SCENE_MODES = ['dialogue','action','quiet','reveal']
- BriefCharacter bővítés: trait (EGY megkülönböztető személyiségjegy, magyarul), trait_in_action (egy konkrét, KÉPEN LÁTHATÓ viselkedés, amelyben ez nyomás alatt megmutatkozik), want (mit akar ebben a történetben).
- Új felső szint: logline (1 mondat), central_conflict (1–2 mondat), conflicts: [{ between: [stable_id, stable_id], nature, stakes }], turning_point: { scene_number, change, prepared_by_scene }.
- BriefScene bővítés: dramatic_function, scene_mode, scene_event (mi változik a jelenet elején és végén: állapot, tudás vagy kapcsolat), information_reveal (milyen új információt kap a néző, és ki nem tudja még; lehet üres), tension_level (1–5), emotional_shift ("kezdő érzelem → záró érzelem").
- Frissítsd az Agent1Output típust, az agent1Schema-t és a normalizálókat, hogy az új mezők végigmenjenek. A séma kulcsmezői: trait, trait_in_action, dramatic_function, scene_mode, scene_event, tension_level, turning_point legyenek `required`, a többi opcionális.
- Tegyél hozzá DEFAULT_DRAMATIC_FUNCTION és DEFAULT_SCENE_MODE konstanst.
Ne tedd required-dá a kulcsmezőkön kívül semmit. Ha a Gemini a sémát túl összetettnek találná, a javasolt tartalék: az új mezők nagy része opcionális marad (ezt csak jelentsd, kulcs nélkül nem tudod kipróbálni).

## 1B. Dramaturgiai szabályok és prompt (agent1-brief.ts, gemini.ts)
Exportálj AGENT1_DRAMATURGY_RULES tömböt (mint az AGENT2_SHOT_RULES), és építsd be az agent1Prompt-ba, a mostani 4–6. pont helyett vagy mellett (a többi pont maradjon):
1. Minden karaktert EGY megkülönböztető személyiségjegy határoz meg (trait), és van hozzá látható viselkedés (trait_in_action). Ne általános jelző ("kedves", "bátor"), ne belső gondolat.
2. Legalább egy karakterpárnak ellentétes célja vagy értéke van: ezt a conflicts rögzíti, a stakes mezőben azzal, hogy mi a tét.
3. Minden jelenetben változik valami (állapot, tudás, kapcsolat); ezt a scene_event írja le. Hangulatjelenet csak scene_mode = quiet lehet, és az is előkészít egy következő változást.
4. Információ adagolása: jelenetenként legfeljebb egy új, fontos információ. A lényeget ne az elején mondd ki. A néző néha többet tud, mint a szereplő (feszültségforrás).
5. A tension_level összességében nő a csúcspontig; egy rövid csökkenés a csúcs előtt megengedett; a climax a legmagasabb, a resolution alacsonyabb.
6. Pontosan EGY fordulat (turning_point) van: megváltoztatja a szereplő célját vagy a kapcsolatot, és egy KORÁBBI jelenet információja készíti elő (prepared_by_scene). Ne puszta meglepetés legyen.
7. A rövid hosszon is legyen fordulat: 3 jelenet = 1. setup/conflict, 2. turn, 3. climax/resolution. A SCENE_RANGE értékei változatlanok (kiindulók).
   2 jelenet = 1. conflict/escalation, 2. climax, amely tartalmazza a fordulatot (turning_point.scene_number = 2, prepared_by_scene = 1). Az eredeti "2. turn+climax+resolution" nem fér egy dramatic_function mezőbe.
8. Ha input_type = script vagy outline: a felhasználó története és eseményei mérvadók. A dramaturgiai mezőket ELEMZÉSKÉNT töltsd ki, ne írd át a történetet.

## 1C. Kódellenőrzés (normaliseBrief)
Nem dob kivételt, a megjegyzés az assumptions-be kerül.
- Érvénytelen dramatic_function / scene_mode: alapértelmezés (DEFAULT_* konstans) + megjegyzés.
- tension_level nem 1–5: szorítsd a tartományba, hiányzónál 3, + megjegyzés. Ha ≥3 jelenetnél minden érték azonos: megjegyzés ("nincs fokozás").
- characters_present, conflicts.between ismeretlen stable_id-ja: dobd el, + megjegyzés.
- turning_point hiányzik vagy a scene_number nincs a jelenetek között: ha van turn jelenet, arra állítsd; egyébként hagyd üresen + megjegyzés. KÓDBAN soha ne találj ki történetelemet.
  Ha nincs turn jelenet, de van climax jelenet (pl. 2 jeleneteknél), a fordulat scene_number-ét a climax jelenetre állítsd, és írj megjegyzést. A change és a prepared_by_scene szövegét ne találd ki: üresen hagyható.
- Karakternél üres trait vagy trait_in_action: megjegyzés.

## 1D. Tesztek (agent1-brief.test.ts)
A meglévő node:test minta és futtatási mód szerint (nézd meg a package.json-t).
- tension szorítás;
- érvénytelen enum → alapértelmezés + megjegyzés;
- ismeretlen characters_present id eldobva;
- hiányzó fordulat nem dob kivételt;
- 2 jeleneten a fordulat a climax jelenetre áll;
- az új mezők végigmennek a normalizálón.
Futtasd az Agent 1 teszteket és a TypeScript-ellenőrzést (tsc --noEmit vagy a projekt saját parancsa). Állj meg és jelents.