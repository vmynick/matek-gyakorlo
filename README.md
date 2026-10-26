# ✨ Szorzótábla Mester

[![Közzététel](https://github.com/vmynick/matek-gyakorlo/actions/workflows/pages.yml/badge.svg)](https://github.com/vmynick/matek-gyakorlo/actions/workflows/pages.yml)

Szorzótábla- és bennfoglalás-gyakorló web-app alsósoknak, tabletre és telefonra. Kitehető a kezdőképernyőre, és telepítés után internet nélkül is működik. Ingyenes. Fiók nélkül semmilyen adatot nem küld sehova.

**▶ Az app megnyitása: https://vmynick.github.io/matek-gyakorlo/**

**👨‍👩‍👧 Szülői / tanári felület: https://vmynick.github.io/matek-gyakorlo/szulo.html** (csak meghívóval)

## Mit tud?

- **Szorzás, osztás (bennfoglalás) vagy vegyesen**, a 0–10-es táblákból. A szorzás a tankönyv szerinti sorrendben jelenik meg: a 4-es tábla 1 × 4, 2 × 4 … 10 × 4.
- **Gyakorló mód:** 3 „csont” jár, vagyis három rossz válasz egyszer javítható.
- **Szülői kikérdező:** szigorú teszt csont nélkül, a kiválasztott táblák minden feladata pontosan egyszer szerepel.
- **Hibák gyakorlása:** a korábban rontott vagy csonttal javított feladatokat kérdezi újra. Egy feladat akkor kerül le a listáról, ha kétszer egymás után elsőre jó.
- **Eredménykimutatás szülőknek:** a rontott és a csonttal javított feladatok listája, valamint az eltelt idő.
- **Fejlődés fül:** grafikon az eddigi tesztekről, és egy **feladat-térkép**. A térkép 11×11-es rácsán színnel látszik, melyik feladat megy biztosan és melyik nem. A lassú válaszokat is jelzi, egy mezőre koppintva pedig megjelennek a részletek.
- A statisztikát csak a szülő törölheti, **szülői PIN-nel**.
- **Sötét mód**, és magától frissül, ha új változat jelenik meg (teszt közben nem).

## Szülőknek és tanároknak (felhő, nem kötelező)

- A szülő vagy tanár **meghívóval** kap hozzáférést, és **e-mailes belépő linkkel** lép be, jelszó nélkül.
- **Csoportok:** családot vagy osztályt hoz létre, gyerekeket ad hozzá (csak becenév és avatar), más felnőtteket hív meg.
- **A gyerek eszközét egy 6 jegyű kód köti össze** a gyerek profiljával. A gyereknek nem kell fiók. Ezután az eredményei minden eszközén közösek, és a felnőttek látják a grafikonját és a feladat-térképét.
- **Internet nélkül is lehet gyakorolni:** az eredmények megvárják a következő kapcsolatot.

## Adatok

- **Összekötés nélkül** minden eredmény csak az eszköz böngészőjében tárolódik (localStorage), semmi nem megy ki az eszközről.
- **Összekötött eszközön** az eredmények a [Supabase](https://supabase.com) adatbázisba kerülnek, az EU-ba (Írország).
  - Gyerekekről csak becenevet és avatart tárolunk.
  - Hogy ki mit láthat, azt az adatbázis szabályai (RLS) biztosítják ([supabase/migrations](supabase/migrations)).
  - Részletek a szülői felületen, a „Milyen adatot tárolunk?” résznél.

## Fejlesztés

Build lépés nincs, a fájlok:
- [szorzotabla.html](szorzotabla.html): a gyakorló app;
- [szulo.html](szulo.html) és [szulo.js](szulo.js): a szülői / tanári felület;
- [stats.js](stats.js) és [common.css](common.css): közös statisztika és színek;
- [cloud.js](cloud.js): a gyerek eszközének szinkronja;
- [sw.js](sw.js): offline működés.

A Chart.js, a canvas-confetti és a supabase-js helyi másolata a [vendor/](vendor/) mappában van.

```sh
npm install                # playwright-core a tesztekhez
npm test                   # böngészős tesztek a gépen lévő Chrome-mal (BROWSER=msedge is jó)
node tests/cloud.test.mjs  # felhő teszt a teszt projekten (titkos kulcs kell hozzá)
```

- **Adatbázis és beállítások:** a [scripts/supabase.mjs](scripts/supabase.mjs) kezeli (`migrate` / `auth` / `status`), a titkok a gépen, környezeti változóban vannak ([scripts/set-secrets.ps1](scripts/set-secrets.ps1)).
- **Közzététel:** a `main` ágra küldött minden változtatás után a GitHub Actions lefuttatja a teszteket, és ha mind átmegy, közzéteszi az appot a GitHub Pages-en.

## Licenc

[MIT](LICENSE). A felhasznált könyvtárak: [Chart.js](https://www.chartjs.org/) (MIT), [canvas-confetti](https://github.com/catdad/canvas-confetti) (ISC), [supabase-js](https://github.com/supabase/supabase-js) (MIT).
