/* Szorzótábla Mester – a feladatok összeállítása, a feladatonkénti eredmények (szorzo_facts) és a mai gyakorlás. */

/* --- FELADATOK ÉS FELADATONKÉNTI STATISZTIKA --- */
// A feladat felépítése (makeQuestion), a feladatonkénti statisztika számítása és a térkép / grafikon
// kirajzolása a közös stats.js-ben van (a szülői felület is azt használja).

function buildDeck(tables, ops) {
    const deck = [];
    tables.forEach(t => ops.forEach(op => {
        if (t === 0 && op !== 'mul') return; // 0-val nem osztunk
        if (op === 'rem') {
            // maradékos osztás a 100-as körben: hányados 1–9, minden lehetséges maradékkal
            for (let n = t; n < (REM_MAX_QUOTIENT + 1) * t; n++) deck.push(makeQuestion('rem', t, n));
            return;
        }
        for (let i = 0; i <= 10; i++) deck.push(makeQuestion(op, t, i));
    }));
    return deck;
}

// Több műveletnél felváltva jönnek, így kevesebb feladatnál is mindegyikből ugyanannyi jut
// (a maradékos osztásból egy táblán sokkal több feladat van, mint a többiből)
function alternateOps(deck) {
    const groups = shuffle(OP_ORDER.map(op => shuffle(deck.filter(q => q.op === op))).filter(g => g.length));
    const out = [];
    for (let i = 0; out.length < deck.length; i++) groups.forEach(g => { if (i < g.length) out.push(g[i]); });
    return out;
}

// Véletlenszerű keverés (Fisher-Yates)
function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// szorzo_facts: { "mul:7:8": { n, ok, bone, bad, r, ms, t } }
// r: a legutóbbi válaszok (o = elsőre jó, b = csonttal javított, x = hibás); ms: az elsőre jó válaszok ideje;
// t: az utolsó válasz ideje (ms), ebből számolja a mai gyakorlás, mikor esedékes az ismétlés
function loadFacts() {
    try {
        return JSON.parse(localStorage.getItem('szorzo_facts') || '{}');
    } catch (e) {
        return {};
    }
}

function recordFact(q, outcome, ms) {
    const facts = loadFacts();
    const f = facts[factKey(q)] || { n: 0, ok: 0, bone: 0, bad: 0, r: '', ms: [] };
    f.n++;
    if (outcome === 'o') f.ok++;
    else if (outcome === 'b') f.bone++;
    else f.bad++;
    f.r = (f.r + outcome).slice(-RECENT);
    if (outcome === 'o' && ms != null) f.ms = [...f.ms, Math.round(ms)].slice(-RECENT);
    f.t = Date.now();
    facts[factKey(q)] = f;
    localStorage.setItem('szorzo_facts', JSON.stringify(facts));
    cloudQueueAnswer(q, outcome, ms, quizMode, currentSessionId);
}

function weakQuestions() {
    const facts = loadFacts();
    return Object.keys(facts)
        .filter(k => OP_SYMBOL[k.split(':')[0]] && isWeak(facts[k]))
        .map(k => ({ q: questionFromKey(k), score: factScore(facts[k]) }));
}

/* --- MAI GYAKORLÁS --- */
// Egy gombnyomásra 10 feladat a gyerek eddigi eredményeiből: előbb a hibásak, aztán az esedékes ismétlések
// (a sorozatban elsőre jó válaszok száma szerint 1, 2, 4, 7, 14 nap után), végül néhány új feladat.
const DAILY_SIZE = 10;
const DAILY_QUOTA = { weak: 4, due: 3, fresh: 3 };
const REVIEW_DAYS = [1, 1, 2, 4, 7, 14];
const DAY_MS = 86400000;
const TABLE_ORDER = [2, 10, 5, 1, 0, 4, 3, 8, 6, 9, 7]; // ebben a sorrendben jönnek az új táblák

const dayIndex = ms => Math.floor((ms - new Date(ms).getTimezoneOffset() * 60000) / DAY_MS);

// 1 = ma esedékes az ismétlés, nagyobb = régóta vár (a lassú feladat legfeljebb 2 naponta jön)
function reviewDue(f, now) {
    const streak = f.r.length - f.r.replace(/o+$/, '').length;
    const box = Math.min(streak, avgMs(f) > SLOW_MS ? 2 : REVIEW_DAYS.length - 1);
    return (dayIndex(now) - dayIndex(f.t || 0)) / REVIEW_DAYS[box];
}

// Új feladatok: a már gyakorolt táblák még nem látott feladatai, utána műveletenként a következő tábla
function freshQuestions(facts) {
    const keys = Object.keys(facts);
    const ops = [...new Set(keys.map(k => k.split(':')[0]).filter(op => OP_SYMBOL[op]))];
    const inUsed = [];
    const inNext = [];
    (ops.length ? ops : ['mul']).forEach(op => {
        const used = new Set(keys.filter(k => k.startsWith(`${op}:`)).map(k => +k.split(':')[1]));
        const unseen = t => buildDeck([t], [op]).filter(q => !facts[factKey(q)]);
        used.forEach(t => inUsed.push(...unseen(t)));
        const next = TABLE_ORDER.find(t => !used.has(t) && unseen(t).length);
        if (next !== undefined) inNext.push(...unseen(next));
    });
    return [...shuffle(inUsed), ...shuffle(inNext)];
}

// { deck, weak, review, fresh }: a feladatok és hogy miből mennyi
function dailyQuestions(facts = loadFacts(), now = Date.now()) {
    const practiced = Object.keys(facts).filter(k => OP_SYMBOL[k.split(':')[0]])
        .map(k => ({ q: questionFromKey(k), f: facts[k], due: reviewDue(facts[k], now) }));
    const pools = {
        weak: shuffle(practiced.filter(e => isWeak(e.f))).sort((a, b) => factScore(a.f) - factScore(b.f)),
        due: shuffle(practiced.filter(e => !isWeak(e.f) && e.due >= 1)).sort((a, b) => b.due - a.due),
        fresh: freshQuestions(facts).map(q => ({ q })),
        rest: practiced.filter(e => !isWeak(e.f) && e.due < 1).sort((a, b) => (a.f.t || 0) - (b.f.t || 0)),
    };
    const picked = [];
    const keys = new Set();
    const take = (kind, max) => {
        for (const e of pools[kind]) {
            if (picked.length >= DAILY_SIZE || max <= 0) break;
            if (keys.has(factKey(e.q))) continue;
            keys.add(factKey(e.q));
            picked.push({ q: e.q, kind });
            max--;
        }
    };
    Object.entries(DAILY_QUOTA).forEach(([kind, max]) => take(kind, max));
    ['weak', 'due', 'fresh', 'rest'].forEach(kind => take(kind, DAILY_SIZE)); // ami még hiányzik
    const count = (...kinds) => picked.filter(p => kinds.includes(p.kind)).length;
    return { deck: picked.map(p => p.q), weak: count('weak'), review: count('due', 'rest'), fresh: count('fresh') };
}

function dailyDoneToday() {
    const today = new Date().toDateString();
    return JSON.parse(localStorage.getItem('szorzo_history') || '[]')
        .some(h => h.mode === 'daily' && h.at && new Date(h.at).toDateString() === today);
}

function renderDaily() {
    const done = dailyDoneToday();
    const { weak, review, fresh } = dailyQuestions();
    document.getElementById('daily-card').classList.toggle('done', done);
    document.getElementById('daily-title').innerText = done ? '✅ A mai gyakorlás megvan!' : '☀️ Mai gyakorlás';
    document.getElementById('daily-info').innerText = done ? 'Ha van kedved, jöhet még egy kör.'
        : `${DAILY_SIZE} feladat, neked válogatva: ` +
          [weak && `🎯 ${weak} javítás`, review && `🔁 ${review} ismétlés`, fresh && `✨ ${fresh} új`].filter(Boolean).join(' · ');
    document.getElementById('daily-btn').innerText = done ? 'Még egy ▶' : 'Indítás ▶';
}

function startDaily() {
    startQuiz(null, 'daily');
}
