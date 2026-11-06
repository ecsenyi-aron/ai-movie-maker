# T4 — page.tsx MENTÉS (CSAK a t3 jóváhagyása után indítható)
Olvasd el a plans/t0-common.md-t. Egy válaszban egy részfeladat.

## 4.1 Hibakezelés (ezzel kezdd)
Minden insert/update hibáját ellenőrizd, és hiba esetén dobj érthető magyar hibaüzenetet (jelezze, melyik lépés bukott). Hiányzó oszlop miatt eddig csendben veszett el a mentés. Állj meg és jelents.

## 4.2 Projekt és brief mentése
Mentsd a projects.brief-et (és a típusos oszlopokat, ha a jóváhagyott javaslat tartalmazza). A genre mezőbe a GENRES zárt lista értéke kerüljön.
A felhasználó legördülő választása továbbra sem jut el az Agent 1-hez (t0 5. pont): ezt ne oldd meg, csak a jelentésben említsd újra.

## 4.3 Helyszínek
Az Agent 1 locations a forrás (stable_id, description), az Agent 2 locations ugyanazzal a stable_id-val egyesül. A scenes.location_id-t a setting név (kis-nagybetű és ékezet érzéketlen) alapján keresd. Tartalék: slugifyId az agent1-brief.ts-ből. A saját replace(/[^a-z0-9]/g,'_') törlendő.

## 4.4 Karakterek
Az Agent 2 canonical_description-je + az Agent 1 profile (role, trait, trait_in_action, want, look) egyesítve stable_id alapján.

## 4.5 Jelenetek
dramaturgy jsonb (dramatic_function, scene_mode, scene_event, information_reveal, tension_level, emotional_shift, summary, characters_present, framing_hint).

## 4.6 Felvételek
editing jsonb az új mezőkkel. Az Agent 2 notes menjen a shots.qc_notes-ba (ha az oszlop létezik, különben jelezd). A /api/agents válaszban a notes már megy: a page eddig eldobta.

## 4.7 UI
Az "Animatic / előnézet" jelölés és a stock-figyelmeztetés maradjon. A jóváhagyási képernyőn jelenjen meg röviden: logline, fordulat, jelenetenként tension_level és scene_event (csak olvasható, ne építs szerkesztőt). Futtasd a teljes tesztet és a TypeScript-ellenőrzést.

## ZÁRÓ JELENTÉS (egyszerű magyarul, a t4 végén)
Mi változott fájlonként; mit találtál a 0. lépésben; tesztek eredménye; mi NEM készült el:
- az Agent 3/5 még nem használja a pre_roll_sec, post_hold_sec, hold, music_cue mezőket (külön lépés);
- szerkesztőfelület és Agent 2 részleges újrafuttatás nincs;
- valódi Gemini-próbát nem futtattál (azt én indítom kézzel).