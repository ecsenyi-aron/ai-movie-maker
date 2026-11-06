# T3 — MENTÉSI HELY ÉS MIGRÁCIÓS JAVASLAT (itt ÁLLJ MEG)
Előfeltétel: a t2 kész. Olvasd el a plans/t0-common.md-t.

Ne alkalmazz semmit. Írj javaslatot a plans/ mappába (a következő szabad migrációs sorszámmal), mutasd meg a chatben, és várd meg a jóváhagyásomat. A javaslat:
- Csak `add column if not exists`, minden oszlop nullable, régi sor és RLS-szabály nem változik.
- Ajánlott: projects.brief jsonb (az Agent 1 teljes normalizált kimenete: egyetlen forrás, ebből futhat újra az Agent 2 oldalfrissítés után is), scenes.dramaturgy jsonb, characters.profile jsonb, shots.editing jsonb. Indok: a mezőkészlet még változik (kiindulók), jsonb-vel nem kell minden finomhangolásnál új migráció.
- Típusos oszlop csak ahol más kód szűr rá. A visual_style: ha a projects.visual_style már létezik (t0 6. pont), ne vedd fel újra. Egyetlen forrás legyen, ne duplázd a brief-fel.
- Ellenőrizd, van-e oszlopszintű GRANT a táblákon (006_table_grants): ha igen, az új oszlopokra is kell. Írd bele a visszaállító (rollback) SQL-t is.
- Mondd meg, kell-e generált típusfájlt újragenerálni.
- Írd le röviden azt is, hogy a szerkesztett jelenetre (Agent 2 újrafuttatása) mit olvasna vissza az adatbázisból.
Írd bele azt is, hogy a shots.qc_notes oszlop létezik-e, mert a t4 az Agent 2 notes-ait oda menti.
SQL-t ne futtass. Állj meg, és hagyd jóvá.