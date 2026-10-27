/* Szorzótábla Mester – segítség rossz válasz után.
   Csontnál egy tipp, ami nem árulja el az eredményt, csak egy lépést mutat (pl. 9 × 7 = 10 × 7 − 7).
   Végleges hibánál a teljes levezetés és egy pöttyös ábra: soronként egy csoport, a levezetés részei színnel
   (a: amiből indulunk, b: amit hozzáadunk, ghost: amit elveszünk, rest: a maradék). */

// Melyik szorzóval a legkönnyebb fejben számolni (kisebb = könnyebb): 0, 1 után 10, 2, aztán 5 ...
const MUL_EASE = [0, 0, 1, 3, 3, 2, 4, 5, 4, 3, 1];
const MINUS = '−';

// "7-esével", "5-ösével", "3-asával", "6-osával"
const byTable = t => `${t}-${TABLE_SUFFIX[t]}${/[eö]s$/.test(TABLE_SUFFIX[t]) ? 'ével' : 'ával'}`;

// Pöttyök: [[sorok száma, fajta], ...] -> soronként { n, kind }
const dotRows = (n, ...parts) => parts.flatMap(([count, kind]) => Array.from({ length: count }, () => ({ n, kind })));

// m × v (m-szer v): tipp, levezetés és pöttyök. A könnyebb részekből rakja össze (2-szer = duplázás, 5-ször = 10-szer fele ...)
function mulPlan(m, v) {
    const p = m * v;
    const x = k => `${k} × ${v}`;
    switch (m) {
        case 0: return { tip: 'Ha valamit 0-szor veszel, az 0.', steps: `${x(0)} = 0`, rows: [] };
        case 1: return { tip: 'Egyszer véve minden szám önmaga marad.', steps: `${x(1)} = ${v}`, rows: dotRows(v, [1, 'a']) };
        case 2: return { tip: `Duplázz: ${v} + ${v}`, steps: `${x(2)} = ${v} + ${v} = ${p}`, rows: dotRows(v, [1, 'a'], [1, 'b']) };
        case 3: return { tip: `${x(3)} = ${x(2)} + ${v}, és ${x(2)} = ${2 * v}`,
            steps: `${x(3)} = ${x(2)} + ${v} = ${2 * v} + ${v} = ${p}`, rows: dotRows(v, [2, 'a'], [1, 'b']) };
        case 4: return { tip: `${x(4)} a ${x(2)} duplája, és ${x(2)} = ${2 * v}`,
            steps: `${x(4)} = ${x(2)} + ${x(2)} = ${2 * v} + ${2 * v} = ${p}`, rows: dotRows(v, [2, 'a'], [2, 'b']) };
        case 5: return { tip: `${x(5)} a ${x(10)} fele, és ${x(10)} = ${10 * v}`,
            steps: `${x(5)} = ${x(10)} fele = ${10 * v} : 2 = ${p}`, rows: dotRows(v, [5, 'a'], [5, 'ghost']) };
        case 6: return { tip: `${x(6)} = ${x(5)} + ${v}, és ${x(5)} = ${5 * v}`,
            steps: `${x(6)} = ${x(5)} + ${v} = ${5 * v} + ${v} = ${p}`, rows: dotRows(v, [5, 'a'], [1, 'b']) };
        case 7: return { tip: `${x(7)} = ${x(5)} + ${x(2)}, és ${x(5)} = ${5 * v}`,
            steps: `${x(7)} = ${x(5)} + ${x(2)} = ${5 * v} + ${2 * v} = ${p}`, rows: dotRows(v, [5, 'a'], [2, 'b']) };
        case 8: return { tip: `${x(8)} = ${x(10)} ${MINUS} ${x(2)}, és ${x(10)} = ${10 * v}`,
            steps: `${x(8)} = ${x(10)} ${MINUS} ${x(2)} = ${10 * v} ${MINUS} ${2 * v} = ${p}`, rows: dotRows(v, [8, 'a'], [2, 'ghost']) };
        case 9: return { tip: `${x(9)} = ${x(10)} ${MINUS} ${v}, és ${x(10)} = ${10 * v}`,
            steps: `${x(9)} = ${x(10)} ${MINUS} ${v} = ${10 * v} ${MINUS} ${v} = ${p}`, rows: dotRows(v, [9, 'a'], [1, 'ghost']) };
        default: return { tip: `${x(10)}: írj egy 0-t a szám mögé!`, steps: `${x(10)} = ${p}`, rows: dotRows(v, [10, 'a']) };
    }
}

// A gyerek a × t-t látja (a-szor t). Ha fordítva könnyebb (pl. 7 × 2 = 2 × 7), úgy vezeti le.
function mulHelp(a, t) {
    if (t === 0) return { tip: 'A 0 akárhányszor összeadva is 0.', steps: `${a} × 0 = 0`, rows: [] };
    if (a === 0 || MUL_EASE[t] >= MUL_EASE[a]) return mulPlan(a, t);
    const plan = mulPlan(t, a);
    return { tip: `Fordítsd meg: ${a} × ${t} = ${t} × ${a}. ${plan.tip}`, steps: `${a} × ${t} = ${plan.steps}`, rows: plan.rows };
}

// Osztás és hiányzó tényező: a szorzásból, 5 × t-től (vagy 0-tól) lépkedve a tábla számain
function divTip(a, t) {
    const p = a * t;
    if (t === 1) return 'Az 1 minden számban annyiszor van meg, amennyi maga a szám.';
    if (p === 0) return 'Mivel kell szorozni, hogy 0 legyen?';
    if (a <= 5) return `Számolj ${byTable(t)}: ${t}, ${2 * t}, ${3 * t} …`;
    return `5 × ${t} = ${5 * t}, innen lépj tovább ${byTable(t)}!`;
}

const divRows = (a, t) => dotRows(t, [Math.min(a, 5), 'a'], [Math.max(a - 5, 0), 'b']);

// Tipp csontnál (given: a gyerek válasza { main, rem }); nem árulja el az eredményt
function hintFor(q, given = {}) {
    const t = q.table;
    if (q.op === 'mul') return mulHelp(q.other, t).tip;
    if (q.op === 'div') return `Gondolj a szorzásra: ? × ${t} = ${q.f1}. ${divTip(q.other, t)}`;
    if (q.op === 'mis') return `Ez ugyanaz, mint ${q.f1} : ${t}. ${divTip(q.other, t)}`;
    // maradékos osztás
    if (given.rem != null && given.rem >= t) return `A maradék mindig kisebb, mint az osztó (${t}).`;
    const c = q.target;
    if (given.main === c) return `A hányados jó! Mennyi marad: ${q.f1} ${MINUS} ${c * t} = ?`;
    const near = [c - 1, c, c + 1].map(k => k * t).join(', ').replace(/, (\d+)$/, ' vagy $1');
    return `Keresd a legnagyobb ${t}-${TABLE_SUFFIX[t]} szorzatot, ami még nem több, mint ${q.f1} (${near}?)`;
}

// A teljes levezetés végleges hiba után: { text, rows }
function explainFor(q) {
    const t = q.table;
    if (q.op === 'mul') {
        const help = mulHelp(q.other, t);
        return { text: help.steps, rows: help.rows };
    }
    if (q.op === 'div') return { text: `${q.f1} : ${t} = ${q.other}, mert ${q.other} × ${t} = ${q.f1}.`, rows: divRows(q.other, t) };
    if (q.op === 'mis') return { text: `${q.other} × ${t} = ${q.f1}, tehát a hiányzó szám: ${q.other}.`, rows: divRows(q.other, t) };
    const whole = q.target * t;
    return {
        text: `${q.f1} : ${t} = ${q.target}, maradék ${q.rem}, mert ${q.target} × ${t} = ${whole}, és ${q.f1} ${MINUS} ${whole} = ${q.rem}.`,
        rows: [...dotRows(t, [q.target, 'a']), ...(q.rem ? [{ n: q.rem, kind: 'rest' }] : [])],
    };
}
