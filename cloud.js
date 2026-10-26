/* Szorzótábla Mester – felhő a gyerek eszközén: összekötés eszköz-kóddal és az eredmények szinkronja.
   Összekötés nélkül minden ugyanúgy működik, csak helyben. Összekötés után az eredmények a gyerekhez
   kerülnek: minden eszközén közösek, és a szülő / tanár is látja őket. Internet nélkül az eredmények
   sorban várnak (szorzo_outbox), és a következő kapcsolatkor feltöltődnek. */

const CLOUD_CHILD_KEY = 'szorzo_child'; // { id, nickname, avatar }
const CLOUD_OUTBOX_KEY = 'szorzo_outbox'; // { answers: [], sessions: [] }
const CLOUD_SYNC_KEY = 'szorzo_last_sync';
const CLOUD_UPLOAD_BATCH = 200;

let cloudClient = null;
let cloudSyncing = null;

// A gyerek eszköze névtelen (anonymous) felhasználó; a munkamenete külön kulcson van, mint a szülői felületé
function cloud() {
    if (!cloudClient && window.supabase && typeof CLOUD_CONFIG !== 'undefined') {
        cloudClient = window.supabase.createClient(CLOUD_CONFIG.url, CLOUD_CONFIG.key, {
            auth: { storageKey: 'szorzo-eszkoz-auth', persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
        });
    }
    return cloudClient;
}

function cloudRead(key, fallback) {
    try {
        return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch (e) {
        return fallback;
    }
}

function cloudWrite(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
}

const linkedChild = () => cloudRead(CLOUD_CHILD_KEY, null);
const cloudOutbox = () => cloudRead(CLOUD_OUTBOX_KEY, { answers: [], sessions: [] });

function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Egy megválaszolt feladat sorba állítása (csak összekötött eszközön)
function cloudQueueAnswer(q, outcome, ms, mode, sessionId) {
    if (!linkedChild()) return;
    const box = cloudOutbox();
    box.answers.push({
        id: newId(), op: q.op, tbl: q.table, other: q.other, outcome,
        ms: ms == null ? null : Math.round(ms), mode, session_id: sessionId,
        answered_at: new Date().toISOString(),
    });
    cloudWrite(CLOUD_OUTBOX_KEY, box);
}

// Egy befejezett teszt összesítője, utána rögtön szinkron
function cloudQueueSession(session) {
    if (!linkedChild()) return;
    const box = cloudOutbox();
    box.sessions.push(session);
    cloudWrite(CLOUD_OUTBOX_KEY, box);
    cloudSync();
}

// Feltöltés, majd a gyerek összesített statisztikájának letöltése (minden eszközéről).
// Visszatérés: true = sikerült, false = nincs összekötve / nincs internet / hiba.
function cloudSync() {
    const child = linkedChild();
    if (!child || !navigator.onLine || !cloud()) return Promise.resolve(false);
    if (cloudSyncing) return cloudSyncing;
    cloudSyncing = (async () => {
        try {
            const { data: { session } } = await cloud().auth.getSession();
            if (!session) {
                cloudForget('Az eszköz kapcsolata megszűnt. Kérj új kódot a szülőtől vagy a tanártól!');
                return false;
            }
            // Össze van-e még kötve? (a szülő leválaszthatta az eszközt)
            const { data: link, error: linkError } = await cloud().from('child_devices')
                .select('child_id').eq('user_id', session.user.id).maybeSingle();
            if (linkError) throw linkError;
            if (!link || link.child_id !== child.id) {
                cloudForget('A szülő vagy a tanár leválasztotta ezt az eszközt.');
                return false;
            }

            const box = cloudOutbox();
            const sentAnswers = new Set();
            const sentSessions = new Set();
            for (let i = 0; i < box.answers.length; i += CLOUD_UPLOAD_BATCH) {
                const rows = box.answers.slice(i, i + CLOUD_UPLOAD_BATCH).map(a => ({ ...a, child_id: child.id }));
                const { error } = await cloud().from('answers').upsert(rows, { onConflict: 'id', ignoreDuplicates: true });
                if (error) throw error;
                rows.forEach(r => sentAnswers.add(r.id));
            }
            if (box.sessions.length) {
                const rows = box.sessions.map(s => ({ ...s, child_id: child.id }));
                const { error } = await cloud().from('quiz_sessions').upsert(rows, { onConflict: 'id', ignoreDuplicates: true });
                if (error) throw error;
                rows.forEach(r => sentSessions.add(r.id));
            }
            // Közben érkezhetett új eredmény: csak a feltöltötteket vesszük ki a sorból
            const rest = cloudOutbox();
            rest.answers = rest.answers.filter(a => !sentAnswers.has(a.id));
            rest.sessions = rest.sessions.filter(s => !sentSessions.has(s.id));
            cloudWrite(CLOUD_OUTBOX_KEY, rest);

            await cloud().rpc('touch_device');
            if (!rest.answers.length) await cloudPull(child.id);
            localStorage.setItem(CLOUD_SYNC_KEY, new Date().toISOString());
            return true;
        } catch (e) {
            console.warn('Szinkron hiba:', e);
            return false;
        } finally {
            cloudSyncing = null;
            if (typeof onCloudSynced === 'function') onCloudSynced();
        }
    })();
    return cloudSyncing;
}

// A felhőben lévő összesítés lesz a helyi statisztika (feladat-térkép, hibák gyakorlása, grafikon)
async function cloudPull(childId) {
    const { data: facts, error } = await cloud().rpc('child_facts', { p_child_id: childId });
    if (error) throw error;
    cloudWrite('szorzo_facts', factsFromCloud(facts));

    const { data: sessions, error: sessionError } = await cloud().from('quiz_sessions')
        .select('pct, mode, finished_at').eq('child_id', childId)
        .order('finished_at', { ascending: false }).limit(20);
    if (sessionError) throw sessionError;
    cloudWrite('szorzo_history', historyFromCloud(sessions));
}

// child_facts sorai -> { "mul:7:8": { n, ok, bone, bad, r, ms } } (a szülői felület is használja)
function factsFromCloud(rows) {
    const facts = {};
    for (const f of rows || []) {
        facts[`${f.op}:${f.tbl}:${f.other}`] = {
            n: f.n, ok: f.ok, bone: f.bone, bad: f.bad, r: f.recent || '',
            ms: f.avg_ms != null ? [f.avg_ms] : [],
        };
    }
    return facts;
}

// quiz_sessions (legújabb elöl) -> a grafikon előzménye (legrégebbi elöl)
function historyFromCloud(rows) {
    return (rows || []).slice().reverse().map(s => ({
        date: new Date(s.finished_at).toLocaleDateString('hu-HU',
            { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
        pct: s.pct, mode: s.mode, at: s.finished_at,
    }));
}

// Összekötés a szülőtől / tanártól kapott kóddal. importLocal: az eszközön eddig gyűjtött eredmények is átkerülnek.
async function cloudLink(code, importLocal) {
    if (!navigator.onLine || !cloud()) throw new Error('Nincs internet. Próbáld újra, ha lesz kapcsolat!');
    const { data: { session } } = await cloud().auth.getSession();
    if (!session) {
        const { error } = await cloud().auth.signInAnonymously();
        if (error) throw new Error(`Nem sikerült csatlakozni: ${error.message}`);
    }
    const { data, error } = await cloud().rpc('redeem_device_code', { p_code: code.trim().toUpperCase() });
    if (error) throw new Error(error.message);
    if (data && data.error) throw new Error(data.error);

    const previous = linkedChild();
    if (previous && previous.id !== data.id) cloudClearLocal(); // másik gyerekhez köt: a régi adatai ne keveredjenek
    cloudWrite(CLOUD_CHILD_KEY, { id: data.id, nickname: data.nickname, avatar: data.avatar });
    if (importLocal && !previous) cloudImportLocal();
    await cloudSync();
    return data;
}

// Az összekötés előtt helyben gyűjtött eredmények sorba állítása (feladatonként a legutóbbi 5 válasz és a tesztek)
function cloudImportLocal() {
    const facts = cloudRead('szorzo_facts', {});
    const history = cloudRead('szorzo_history', []);
    const box = cloudOutbox();
    const now = Date.now();
    for (const [key, f] of Object.entries(facts)) {
        const [op, tbl, other] = key.split(':');
        if (!['mul', 'div'].includes(op)) continue;
        const outcomes = [...(f.r || '')];
        const times = [...(f.ms || [])];
        outcomes.forEach((outcome, i) => {
            // az elsőre jó válaszok ideje a legutóbbiakhoz tartozik: hátulról osztjuk ki
            const ms = outcome === 'o' && times.length ? times.splice(-1, 1)[0] : null;
            box.answers.push({
                id: newId(), op, tbl: +tbl, other: +other, outcome, ms, mode: null, session_id: null,
                answered_at: new Date(now - (outcomes.length - i) * 1000).toISOString(), imported: true,
            });
        });
    }
    history.forEach((h, i) => {
        const at = h.at ? new Date(h.at) : new Date(now - (history.length - i) * 60000);
        box.sessions.push({
            id: newId(), mode: ['practice', 'exam', 'weak'].includes(h.mode) ? h.mode : 'practice',
            pct: h.pct, finished_at: (isNaN(at) ? new Date(now) : at).toISOString(), imported: true,
        });
    });
    cloudWrite(CLOUD_OUTBOX_KEY, box);
}

// Kapcsolat bontása: az eszköz leválik a gyerekről (a felhőben lévő adatai megmaradnak)
async function cloudUnlink() {
    try {
        await cloudSync(); // ami még nem ment fel, előbb felmegy
        const { data: { session } } = await cloud().auth.getSession();
        if (session) await cloud().from('child_devices').delete().eq('user_id', session.user.id);
        await cloud().auth.signOut();
    } catch (e) {
        console.warn('Leválasztási hiba:', e);
    }
    cloudForget();
}

// Az összekötés helyi nyomainak törlése (a gyerek statisztikája a felhőben marad)
function cloudForget(reason) {
    cloudClearLocal();
    localStorage.removeItem(CLOUD_CHILD_KEY);
    if (reason && typeof showToast === 'function') showToast(`☁️ ${reason}`);
}

function cloudClearLocal() {
    [CLOUD_OUTBOX_KEY, CLOUD_SYNC_KEY, 'szorzo_facts', 'szorzo_history'].forEach(k => localStorage.removeItem(k));
}
