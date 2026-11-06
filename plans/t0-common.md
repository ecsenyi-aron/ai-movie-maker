# KÖZÖS SZABÁLYOK + 0. ELLENŐRZÉS

## Működési szabályok (az egész feladatsorra érvényesek)
- Először olvasd el: src/lib/agents/agent1-brief.ts, agent2-rules.ts, src/lib/gemini.ts, src/app/api/agents/route.ts, src/app/page.tsx, a meglévő teszteket, a migrációs fájlokat és a plans/ mappát. Utána kezdj módosítani.
- Gemini-hívások száma nem nőhet: ügynökönként 1 hívás + legfeljebb 1 javítás, mint most. Az ÚJ szabályok csak megjegyzést (notes) adnak, javítási hívást nem indítanak. A REPAIR_RULES marad {1, 2, 5}.
- A folyamatot semmi nem állíthatja le: a normalizálók nem dobnak kivételt; hiány vagy érvénytelen érték esetén alapértelmezés + magyar megjegyzés (Agent 1: assumptions, Agent 2: notes / qc_notes).
- A SCENE_RANGE, a STYLE_MARKERS és minden új számérték KIINDULÓ ÉRTÉK: írd a kommentbe is, egy helyen, egy konstansban legyen hangolható, és sehol se állítsd róla, hogy ellenőrzött.
- Stílus: zárt szókészlet = `as const` tömb + típus + normalizáló (mint most). Kommentek, UI-szövegek, megjegyzések magyarul; azonosítók angolul. Minden új mező opcionális, hogy a régi sorok és tesztek működjenek.

## 0. Ellenőrzés és rövid jelentés (kód nélkül, 10 sor)
Erősítsd meg vagy cáfold az alábbi megfigyeléseimet, és írd le, hol térnek el:
1. page.tsx az Agent 1 teljes (normalizált) eredményét átadja a /api/agents agent2 hívásnak, és a runAgent2 megkapja. DE az agent2Prompt csak a scenes-t és a briefContextBlock mezőit (genre, visual_style, input_type, characters, locations) használja; a normaliseScenes eldobja az ismeretlen mezőket, ezért minden új mezőt ott is fel kell venni.
2. A page az Agent 1-ből csak a jelenetek number, title, description, time_of_day, location_id mezőit menti. A summary, characters_present, framing_hint, assumptions, visual_style, length_class, input_type, az Agent 1 characters/locations listája nem kerül adatbázisba. Az eredmény csak React-állapotban él, oldalfrissítés után elvész.
3. A page a helyszíneket a jelenet setting szövegéből, saját loc_ + replace(/[^a-z0-9]/g,'_') azonosítóval hozza létre: ez a magyar ékezetes betűket kiejti (ütközhet), és az Agent 1 locations stable_id-it figyelmen kívül hagyja. Az Agent 2 locations listáját nem menti.
4. A page insert/update hívásainak hibáját nem ellenőrzi (await supabase... hibaág nélkül): hibás vagy hiányzó oszlop esetén a mentés csendben elmarad.
5. A "Film műfaja" legördülő értéke (pl. "Thriller", "Animációs") nem jut el az Agent 1-hez, és nem is a GENRES zárt lista tagja. NE változtasd meg a legördülőt, csak jelentsd.
6. Keresd meg, hol olvassa az Agent 4 (agent4-composer.ts, agent4-premium-config.ts) a visual_style-t, és mely oszlopok léteznek már a projects, scenes, characters, shots táblákon (migrációs fájlok, plans/agent4_migrations_008_009.md).
7. Ellenőrizd: létrehoz-e a gemini.ts importáláskor Gemini-klienst úgy, hogy egy teszt importja kulcs nélkül elbukna. Jelentsd, de ne módosíts.