/* Szorzótábla Mester – közös statisztika: feladatok, feladat-térkép (hőtérkép) és a fejlődés grafikon.
   A gyakorló app (szorzotabla.html) és a szülői / tanári felület (szulo.html) is ezt használja. */

// Egy feladat: op, table (a tábla), other (a másik szám).
// Szorzás (mul): other × table = ? (a tankönyv szerint: 4-es tábla = 1 × 4, 2 × 4, 3 × 4 ...)
// Osztás, bennfoglalás (div): (other·table) : table = other
// Hiányzó tényező (mis): ? × table = other·table, a válasz other
// Maradékos osztás (rem): other : table = hányados, maradék (other az osztandó, table az osztó)
const OP_SYMBOL = { mul: '×', div: ':', mis: '×', rem: ':' };
const OP_NAMES = { mul: 'szorzás', div: 'osztás', mix: 'vegyes', mis: 'hiányzó tényező', rem: 'maradékos osztás' };
const RECENT = 5; // ennyi legutóbbi választ tartunk meg feladatonként
const SLOW_MS = 6000; // ennél lassabb átlagos válasz "lassú" a térképen
const REM_MAX_QUOTIENT = 9; // maradékos osztás a 100-as körben: a hányados 1–9
// Magyar rag a szám kiejtése szerint: 0-s, 3-as, 5-ös, 6-os...
const TABLE_SUFFIX = ['s', 'es', 'es', 'as', 'es', 'ös', 'os', 'es', 'as', 'es', 'es'];

function makeQuestion(op, table, other) {
    if (op === 'div' || op === 'mis') return { op, table, other, f1: table * other, f2: table, target: other };
    if (op === 'rem') return { op, table, other, f1: other, f2: table, target: Math.floor(other / table), rem: other % table };
    return { op, table, other, f1: other, f2: table, target: table * other };
}

const factKey = q => `${q.op}:${q.table}:${q.other}`;
// A feladat, ahogy a gyerek látja ("8 × 7", "? × 7 = 56"), és megoldva ("8 × 7 = 56", "38 : 7 = 5, maradék 3")
const questionText = q => (q.op === 'mis' ? `? × ${q.f2} = ${q.f1}` : `${q.f1} ${OP_SYMBOL[q.op]} ${q.f2}`);
const answerText = q => (q.op === 'rem' ? `${q.target}, maradék ${q.rem}` : `${q.target}`);
const solutionText = q => (q.op === 'mis' ? `${questionText(q)} → ${q.target}` : `${questionText(q)} = ${answerText(q)}`);

function questionFromKey(key) {
    const [op, table, other] = key.split(':');
    return OP_SYMBOL[op] ? makeQuestion(op, +table, +other) : null;
}

// Feladatonkénti statisztika: { n, ok, bone, bad, r, ms }
// r: a legutóbbi válaszok (o = elsőre jó, b = csonttal javított, x = hibás); ms: az elsőre jó válaszok ideje
// Gyakorlásra vár, ha nemrég hibás vagy csonttal javított volt, és azóta nincs két egymás utáni jó válasza
const isWeak = f => /[bx]/.test(f.r) && !f.r.endsWith('oo');
// 0..1: a legutóbbi válaszok átlaga (elsőre jó = 1, csonttal = 0,5, hibás = 0)
const factScore = f => [...f.r].reduce((s, c) => s + (c === 'o' ? 1 : c === 'b' ? 0.5 : 0), 0) / f.r.length;
const avgMs = f => f.ms.length ? f.ms.reduce((a, b) => a + b, 0) / f.ms.length : null;

// Csillagok egy befejezett tesztért: 1, ha legalább 10 feladatos (a hibák gyakorlása kevesebből is), +1, ha hibátlan;
// egy kiosztott feladat első teljesítése +2. A felhő ugyanígy számol (star_events a supabase/migrations alatt).
function sessionStars(s, firstTryOfAssignment) {
    const base = s.total >= 10 || (s.mode === 'weak' && s.total >= 1) ? 1 + (s.pct === 100 ? 1 : 0) : 0;
    return base + (s.assignment_id && firstTryOfAssignment ? 2 : 0);
}
const STAR_RULES = '1 ⭐ minden legalább 10 feladatos tesztért (a hibák gyakorlásáért kevesebből is), +1 ⭐, ha hibátlan, ' +
    '+2 ⭐ egy kiosztott feladat első teljesítéséért – és amit a felnőttek ajándékoznak.';

// 0..1 eredményből szín-szint (0 = nem megy … 4 = biztos)
const levelOf = s => (s >= 0.9 ? 4 : s >= 0.7 ? 3 : s >= 0.5 ? 2 : s >= 0.3 ? 1 : 0);
const heatLevel = f => levelOf(factScore(f));

const HEATMAP_HELP = {
    mul: 'Sor: melyik tábla, oszlop: hányszor (a 7-es sor 8-as oszlopa: 8 × 7).',
    div: 'Sor: osztó, oszlop: hányados (a 7-es sor 8-as oszlopa: 56 : 7).',
    mis: 'Sor: a tábla, oszlop: a hiányzó szám (a 7-es sor 8-as oszlopa: ? × 7 = 56).',
    rem: 'Sor: osztó, oszlop: hányados, egy mezőben az összes maradék (a 7-es sor 5-ös oszlopa: 35–41 : 7).',
};

// Egy maradékos osztás mező: az osztó (t) és a hányados (c) összes maradékkal
const remCellTitle = (t, c) => (t === 1 ? solutionText(makeQuestion('rem', 1, c))
    : `${c * t}–${c * t + t - 1} : ${t} = ${c}, maradék 0–${t - 1}`);

// A feladat-térkép kirajzolása: sor = tábla (osztásnál osztó), oszlop = hányszor (osztásnál hányados).
// Maradékos osztásnál egy mező az azonos hányadosú feladatok együtt (a maradékok átlaga).
// opts (a csoport-összesítéshez): score(f) 0..1, slow(f), detail(q, f) -> HTML, detailMany(title, [[q, f]]) -> HTML
function renderHeatmapGrid(grid, detailEl, facts, op, opts = {}) {
    const score = opts.score || factScore;
    const slow = opts.slow || (f => avgMs(f) > SLOW_MS);
    const detail = opts.detail || factDetailHtml;
    const detailMany = opts.detailMany || factsDetailHtml;
    const isRem = op === 'rem';
    const firstRow = op === 'mul' ? 0 : 1; // 0-val nem osztunk
    const cols = [];
    for (let c = isRem ? 1 : 0; c <= (isRem ? REM_MAX_QUOTIENT : 10); c++) cols.push(c);
    grid.innerHTML = '';
    // a rács méretezéséhez (fejléc + táblák)
    grid.style.setProperty('--hm-rows', 12 - firstRow);
    grid.style.setProperty('--hm-cols', cols.length + 1);
    detailEl.innerText = `${HEATMAP_HELP[op]} Koppints egy mezőre a részletekért!`;

    const addHead = text => {
        const el = document.createElement('div');
        el.className = 'hm-cell hm-head';
        el.innerText = text;
        grid.appendChild(el);
    };

    addHead(OP_SYMBOL[op]);
    cols.forEach(addHead);
    for (let t = firstRow; t <= 10; t++) {
        addHead(t);
        for (const c of cols) {
            const qs = [];
            if (isRem) for (let n = c * t; n < (c + 1) * t; n++) qs.push(makeQuestion('rem', t, n));
            else qs.push(makeQuestion(op, t, c));
            const items = qs.map(q => [q, facts[factKey(q)]]).filter(([, f]) => f);
            const cell = document.createElement('button');
            const avg = items.reduce((s, [, f]) => s + score(f), 0) / items.length;
            cell.className = `hm-cell ${items.length ? 'hm-l' + levelOf(avg) : 'hm-none'}`;
            if (items.length && items.filter(([, f]) => slow(f)).length * 2 >= items.length) cell.classList.add('slow');
            // szorzásnál a szorzat, osztásnál az osztandó, maradékos osztásnál a legkisebb osztandó
            cell.innerText = op === 'mul' ? qs[0].target : qs[0].f1;
            const title = isRem ? remCellTitle(t, c) : solutionText(qs[0]);
            cell.title = title;
            cell.onclick = () => {
                grid.querySelectorAll('.hm-cell.selected').forEach(c => c.classList.remove('selected'));
                cell.classList.add('selected');
                if (!items.length) detailEl.innerHTML = `<strong>${title}</strong><br>Még nem szerepelt.`;
                else detailEl.innerHTML = isRem ? detailMany(title, items) : detail(...items[0]);
            };
            grid.appendChild(cell);
        }
    }
}

const msText = ms => `${(ms / 1000).toFixed(1).replace('.', ',')} mp`;
const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Egy gyerek egy feladatának részletei
function factDetailHtml(q, f) {
    const icons = { o: '✅', b: '🦴', x: '❌' };
    const ms = avgMs(f);
    return `<strong>${solutionText(q)}</strong>${isWeak(f) ? ' · 🎯 gyakorlásra vár' : ''}<br>` +
        `${f.n} válasz: ✅ ${f.ok} · 🦴 ${f.bone} · ❌ ${f.bad}` +
        (ms !== null ? ` · átlag ${msText(ms)}` : '') +
        `<br>Legutóbbiak: ${[...f.r].map(c => icons[c]).join(' ')}`;
}

// Egy gyerek több feladata egy mezőben (maradékos osztás): összesen, és melyik vár gyakorlásra
function factsDetailHtml(title, items) {
    const sum = k => items.reduce((s, [, f]) => s + f[k], 0);
    const weak = items.filter(([, f]) => isWeak(f)).map(([q]) => questionText(q));
    return `<strong>${title}</strong><br>${sum('n')} válasz: ✅ ${sum('ok')} · 🦴 ${sum('bone')} · ❌ ${sum('bad')}<br>` +
        (weak.length ? `🎯 Gyakorlásra vár: ${weak.join(', ')}` : `🎉 ${items.length} feladat gyakorolva, egyik sem vár gyakorlásra.`);
}

const kidList = kids => kids.map(k => `${escHtml(k.avatar)} ${escHtml(k.nickname)}`).join(', ');

// Csoport-összesítés egy feladatra (group_facts sor): hány gyerek gyakorolta, kinek kell még
const GROUP_HEATMAP = {
    score: f => f.avg_score,
    slow: f => f.avg_ms != null && f.avg_ms > SLOW_MS,
    detail: (q, f) => `<strong>${solutionText(q)}</strong> · ${f.kids} gyerek gyakorolta` +
        (f.avg_ms != null ? ` · átlag ${msText(f.avg_ms)}` : '') + '<br>' +
        (f.weak_kids.length ? `🎯 Gyakorolnia kell: ${kidList(f.weak_kids)}` : '🎉 Mindenkinek megy, aki gyakorolta.'),
    detailMany: (title, items) => {
        const weak = new Map();
        items.forEach(([, f]) => f.weak_kids.forEach(k => weak.set(`${k.avatar}${k.nickname}`, k)));
        return `<strong>${title}</strong> · ${Math.max(...items.map(([, f]) => f.kids))} gyerek gyakorolta<br>` +
            (weak.size ? `🎯 Gyakorolnia kell: ${kidList([...weak.values()])}` : '🎉 Mindenkinek megy, aki gyakorolta.');
    },
};

// group_facts sorai -> { "mul:7:8": {...} }
function groupFactsMap(rows) {
    const facts = {};
    for (const f of rows || []) facts[`${f.op}:${f.tbl}:${f.other}`] = { ...f, avg_score: Number(f.avg_score) };
    return facts;
}

// Fejlődés grafikon a tesztek százalékaiból (history: [{ date, pct, mode }]). A régit lecseréli.
function buildProgressChart(canvas, history, oldChart) {
    if (oldChart) oldChart.destroy();
    if (typeof Chart === 'undefined') return null;

    // A színek a témából jönnek (világos / sötét mód)
    const css = getComputedStyle(document.documentElement);
    const themeColor = name => css.getPropertyValue(name).trim();
    const axis = { ticks: { color: themeColor('--text-muted') }, grid: { color: themeColor('--border') } };

    return new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
            // Rövid felirat a tengelyen (kevés hely van), a dátum a buborékban látszik
            labels: history.map((h, idx) => `${idx + 1}.`),
            datasets: [{
                label: 'Eredmény (%)',
                data: history.map(h => h.pct),
                borderColor: themeColor('--primary-text'),
                backgroundColor: 'rgba(79, 70, 229, 0.15)',
                borderWidth: 3,
                fill: true,
                tension: 0.3,
                pointRadius: 5,
                pointBackgroundColor: '#06b6d4'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: axis,
                y: {
                    min: 0,
                    max: 100,
                    grid: axis.grid,
                    ticks: { ...axis.ticks, callback: value => value + '%', maxTicksLimit: 6 }
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: { title: items => `${items[0].label} teszt – ${history[items[0].dataIndex].date}` }
                }
            }
        }
    });
}
