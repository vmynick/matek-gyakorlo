/* Szorzótábla Mester – közös statisztika: feladatok, feladat-térkép (hőtérkép) és a fejlődés grafikon.
   A gyakorló app (szorzotabla.html) és a szülői / tanári felület (szulo.html) is ezt használja. */

// Egy feladat: op ('mul' vagy 'div'), table (a tábla), other (a másik szám).
// Szorzás: other × table = ? (a tankönyv szerint: 4-es tábla = 1 × 4, 2 × 4, 3 × 4 ...)
// Osztás (bennfoglalás): (other·table) : table = other
const OP_SYMBOL = { mul: '×', div: ':' };
const RECENT = 5; // ennyi legutóbbi választ tartunk meg feladatonként
const SLOW_MS = 6000; // ennél lassabb átlagos válasz "lassú" a térképen

function makeQuestion(op, table, other) {
    return op === 'div'
        ? { op, table, other, f1: table * other, f2: table, target: other }
        : { op, table, other, f1: other, f2: table, target: table * other };
}

const factKey = q => `${q.op}:${q.table}:${q.other}`;
const questionText = q => `${q.f1} ${OP_SYMBOL[q.op]} ${q.f2}`;

// Feladatonkénti statisztika: { n, ok, bone, bad, r, ms }
// r: a legutóbbi válaszok (o = elsőre jó, b = csonttal javított, x = hibás); ms: az elsőre jó válaszok ideje
// Gyakorlásra vár, ha nemrég hibás vagy csonttal javított volt, és azóta nincs két egymás utáni jó válasza
const isWeak = f => /[bx]/.test(f.r) && !f.r.endsWith('oo');
// 0..1: a legutóbbi válaszok átlaga (elsőre jó = 1, csonttal = 0,5, hibás = 0)
const factScore = f => [...f.r].reduce((s, c) => s + (c === 'o' ? 1 : c === 'b' ? 0.5 : 0), 0) / f.r.length;
const avgMs = f => f.ms.length ? f.ms.reduce((a, b) => a + b, 0) / f.ms.length : null;

// 0..1 eredményből szín-szint (0 = nem megy … 4 = biztos)
const levelOf = s => (s >= 0.9 ? 4 : s >= 0.7 ? 3 : s >= 0.5 ? 2 : s >= 0.3 ? 1 : 0);
const heatLevel = f => levelOf(factScore(f));

// A feladat-térkép kirajzolása: sor = tábla (osztásnál osztó), oszlop = hányszor (osztásnál hányados).
// opts (a csoport-összesítéshez): score(f) 0..1, slow(f), detail(q, f) -> HTML
function renderHeatmapGrid(grid, detailEl, facts, op, opts = {}) {
    const score = opts.score || factScore;
    const slow = opts.slow || (f => avgMs(f) > SLOW_MS);
    const detail = opts.detail || factDetailHtml;
    const isDiv = op === 'div';
    grid.innerHTML = '';
    grid.style.setProperty('--hm-rows', isDiv ? 11 : 12); // a rács méretezéséhez (fejléc + táblák)
    detailEl.innerText = isDiv
        ? 'Sor: osztó, oszlop: hányados (a 7-es sor 8-as oszlopa: 56 : 7). Koppints egy mezőre a részletekért!'
        : 'Sor: melyik tábla, oszlop: hányszor (a 7-es sor 8-as oszlopa: 8 × 7). Koppints egy mezőre a részletekért!';

    const addHead = text => {
        const el = document.createElement('div');
        el.className = 'hm-cell hm-head';
        el.innerText = text;
        grid.appendChild(el);
    };

    addHead(OP_SYMBOL[op]);
    for (let c = 0; c <= 10; c++) addHead(c);
    for (let t = isDiv ? 1 : 0; t <= 10; t++) {
        addHead(t);
        for (let c = 0; c <= 10; c++) {
            const q = makeQuestion(op, t, c);
            const f = facts[factKey(q)];
            const cell = document.createElement('button');
            cell.className = `hm-cell ${f ? 'hm-l' + levelOf(score(f)) : 'hm-none'}`;
            if (f && slow(f)) cell.classList.add('slow');
            cell.innerText = isDiv ? q.f1 : q.target; // osztásnál az osztandó, szorzásnál a szorzat
            cell.title = `${questionText(q)} = ${q.target}`;
            cell.onclick = () => {
                grid.querySelectorAll('.hm-cell.selected').forEach(c => c.classList.remove('selected'));
                cell.classList.add('selected');
                detailEl.innerHTML = f ? detail(q, f) : `<strong>${questionText(q)} = ${q.target}</strong><br>Még nem szerepelt.`;
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
    return `<strong>${questionText(q)} = ${q.target}</strong>${isWeak(f) ? ' · 🎯 gyakorlásra vár' : ''}<br>` +
        `${f.n} válasz: ✅ ${f.ok} · 🦴 ${f.bone} · ❌ ${f.bad}` +
        (ms !== null ? ` · átlag ${msText(ms)}` : '') +
        `<br>Legutóbbiak: ${[...f.r].map(c => icons[c]).join(' ')}`;
}

// Csoport-összesítés egy feladatra (group_facts sor): hány gyerek gyakorolta, kinek kell még
const GROUP_HEATMAP = {
    score: f => f.avg_score,
    slow: f => f.avg_ms != null && f.avg_ms > SLOW_MS,
    detail: (q, f) => `<strong>${questionText(q)} = ${q.target}</strong> · ${f.kids} gyerek gyakorolta` +
        (f.avg_ms != null ? ` · átlag ${msText(f.avg_ms)}` : '') + '<br>' +
        (f.weak_kids.length
            ? `🎯 Gyakorolnia kell: ${f.weak_kids.map(k => `${escHtml(k.avatar)} ${escHtml(k.nickname)}`).join(', ')}`
            : '🎉 Mindenkinek megy, aki gyakorolta.'),
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
