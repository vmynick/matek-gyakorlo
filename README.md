# ✨ Szorzótábla Mester

[![Közzététel](https://github.com/vmynick/matek-gyakorlo/actions/workflows/pages.yml/badge.svg)](https://github.com/vmynick/matek-gyakorlo/actions/workflows/pages.yml)

Szorzótábla- és bennfoglalás-gyakorló web-app alsósoknak, tabletre és telefonra. Kitehető a kezdőképernyőre, és telepítés után internet nélkül is működik. Ingyenes, és semmilyen adatot nem küld sehova.

**▶ Az app megnyitása: https://vmynick.github.io/matek-gyakorlo/**

## Mit tud?

- **Szorzás, osztás (bennfoglalás) vagy vegyesen**, a 0–10-es táblákból. A szorzás a tankönyv szerinti sorrendben jelenik meg: a 4-es tábla 1 × 4, 2 × 4 … 10 × 4.
- **Gyakorló mód:** 3 „csont” jár, vagyis három rossz válasz egyszer javítható.
- **Szülői kikérdező:** szigorú teszt csont nélkül, a kiválasztott táblák minden feladata pontosan egyszer szerepel.
- **Hibák gyakorlása:** a korábban rontott vagy csonttal javított feladatokat kérdezi újra. Egy feladat akkor kerül le a listáról, ha kétszer egymás után elsőre jó.
- **Eredménykimutatás szülőknek:** a rontott és a csonttal javított feladatok listája, valamint az eltelt idő.
- **Fejlődés fül:** grafikon az eddigi tesztekről, és egy **feladat-térkép**. A térkép 11×11-es rácsán színnel látszik, melyik feladat megy biztosan és melyik nem. A lassú válaszokat is jelzi, egy mezőre koppintva pedig megjelennek a részletek.
- A statisztikát csak a szülő törölheti, **szülői PIN-nel**.

## Adatok

Minden eredmény csak az adott eszköz böngészőjében tárolódik (localStorage). Nincs fiók, nincs szerver, semmi nem megy ki az eszközről. Ezért a statisztika eszközönként külön van.

## Fejlesztés

Egyetlen HTML fájl ([szorzotabla.html](szorzotabla.html)), build lépés nélkül. A Chart.js és a canvas-confetti helyi másolata a [vendor/](vendor/) mappában van. Az offline működést a [sw.js](sw.js) service worker adja.

```sh
npm install   # playwright-core a tesztekhez
npm test      # böngészős tesztek a gépen lévő Chrome-mal (BROWSER=msedge is jó)
```

A `main` ágra küldött minden változtatás után a GitHub Actions lefuttatja a teszteket, és ha mind átmegy, közzéteszi az appot a GitHub Pages-en.

## Licenc

[MIT](LICENSE). A felhasznált könyvtárak: [Chart.js](https://www.chartjs.org/) (MIT), [canvas-confetti](https://github.com/catdad/canvas-confetti) (ISC).
