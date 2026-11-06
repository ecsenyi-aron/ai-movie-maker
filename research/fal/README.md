# fal.ai kutatási segédletek

Ez a mappa **kutatási segédleteket** tartalmaz, nem alkalmazáskódot.
Ezek a fájlok a fal.ai dokumentáció és API-válaszok helyi másolatai, illetve
kis parancssori segédscriptek, amelyekkel a prémium (Agent 4) integráció
paramétereit és árazását ellenőriztük.

**Semmi ebben a mappában nem fut az alkalmazásban.** Az alkalmazás kódja a
[`src/`](../../src) könyvtárban van, a fal.ai hívások pedig a
[`src/lib/agents/agent4-provider.ts`](../../src/lib/agents/agent4-provider.ts)
modulban.

## Tartalom

### API-válaszok és dokumentáció másolatai

| Fájl | Mi tartozik bele |
| --- | --- |
| `fal-auth.html` | A fal.ai hitelesítési (API-kulcs) oldal mentett másolata. |
| `fal-kling.html` | A Kling v3 `image-to-video` endpoint séma- és áradokumentációja. Innen származik a `elements` tömb pontos szerkezete (`KlingV3ComboElementInput`: `frontal_image_url` + legfeljebb 3 `reference_image_urls`). |
| `fal-kling.json` | A Kling v3 endpoint nyers JSON leírása. |
| `fal-lipsync.html` | A Kling lip-sync (`audio-to-video`) endpoint dokumentációja. |
| `fal-flux.html` | A FLUX referencia-kép endpoint dokumentációja. |
| `fal-schnell.html` | A FLUX Schnell (gyors referencia-kép) endpoint dokumentációja. |
| `fal-models.html` | A fal.ai modell-lista oldal mentett másolata. |
| `fal-queue.json` | A fal.ai Queue API válaszformátuma (a `request_id` / státuszlekérdezés). |

### Segédscriptek

| Fájl | Mit csinál |
| --- | --- |
| `tmp-fal-inspect.cjs` | A `fal-auth.html` szövegéből keresi ki a hitelesítési mintákat (`Authorization`, `Key `, `FAL_KEY`, `Bearer`). |
| `tmp-fal-parse.cjs` | Több fájlon végigkeresi a lényeges kulcsszavakat (`price`, `duration`, `elements`, `start_image_url`, ...). Argumentumként kapja a fájlokat. |
| `tmp-fal-params.cjs` | Egy adott fájlban keres konkrét paraméter- vagy mezőneveket. Argumentumként kapja a fájlt és a keresett neveket. |
| `tmp-fal-billing.cjs` | A `billing_unit` mezőket és az endpoint-azonosítókat listázza ki az átadott JSON fájlokból. |

## Használat

A scriptek Node.js-t igényelnek, és a mappán belül futtathatók:

```bash
cd research/fal
node tmp-fal-parse.cjs fal-kling.html
node tmp-fal-params.cjs fal-kling.json elements frontal_image_url
node tmp-fal-billing.cjs fal-kling.json
```

## Karbantartás

Ezek a fájlok **mentett offline másolatok**. Nem frissülnek automatikusan, és
nem tartoznak a buildhez vagy a tesztekhez. Ha a fal.ai API sémája változik,
a [`src/lib/agents/agent4-provider.ts`](../../src/lib/agents/agent4-provider.ts)
modul `submitVideo` metódusát ezekből a mentett anyagokból kell újra
ellenőrizni.
