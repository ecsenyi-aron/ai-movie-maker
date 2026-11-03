# Éles / Helyi Futtatási Útmutató (Production Guide)

Ahhoz, hogy az AI Filmstúdió alkalmazás teljesen élesben és hibátlanul fusson a gépeden vagy szerveren, kövesd az alábbi lépéseket:

## 1. Környezeti Változók Beállítása (`.env.local`)
H hozz létre vagy ellenőrizd a `.env.local` fájlt a projekt gyökerében a következő tartalommal:

```env
NEXT_PUBLIC_SUPABASE_URL=https://<your-supabase-project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<your-supabase-anon-key>
GEMINI_API_KEY=<your-google-gemini-api-key>
PIXABAY_API_KEY=<optional-pixabay-api-key-for-stock-videos>
```

## 2. Supabase Adatbázis és Storage Migráció
1. Lépj be a [Supabase Dashboard](https://supabase.com) felületére.
2. Nyisd meg az **SQL Editor** menüpontot.
3. Másold be és futtasd le a [`001_initial_schema.sql`](supabase/migrations/001_initial_schema.sql) fájl tartalmát. Ez létrehozza az összes szükséges táblát (`projects`, `screenplays`, `characters`, `locations`, `scenes`, `shots`, `generation_jobs`, `media_assets`), az Enum típusokat, az RLS (Row Level Security) biztonsági politikákat és a privát `media` Storage bucketet.

## 3. Rendszerállapot Ellenőrzése (`/setup`)
Indítsd el a fejlesztői szervert:
```bash
npm run dev
```
Majd böngészőben nyisd meg a `http://localhost:3000/setup` oldalt ([`SetupCheck.tsx`](src/components/SetupCheck.tsx)), amely ellenőrzi a Supabase kapcsolatot és a Gemini API kulcs helyességét.

## 4. A Filmstúdió Használata
1. Nyisd meg a főoldalt (`http://localhost:3000` / [`page.tsx`](src/app/page.tsx)).
2. Add meg a filmötletet és a műfajt.
3. Kattints a **„Projekt Létrehozása és Ügynökök Indítása”** gombra (1. és 2. Ügynök futtatása).
4. Ellenőrizd a generált jeleneteket, forgatókönyvet és shot listát a jóváhagyási ellenőrzőponton.
5. Válaszd ki a módot (Stock videó vagy Prémium AI), majd kattints a **„Jóváhagyás és gyártás indítása”** gombra (3., 4. és 5. Ügynök automatikus futtatása: audio, stock klip keresés, QC minőségellenőrzés).
6. Tekintsd meg az elkészült animatic előnézetet!
