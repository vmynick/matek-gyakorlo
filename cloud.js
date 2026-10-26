/* Szorzótábla Mester – felhő a gyerek eszközén: összekötés eszköz-kóddal és az eredmények szinkronja.
   Összekötés nélkül minden ugyanúgy működik, csak helyben. Összekötés után az eredmények a gyerekhez
   kerülnek: minden eszközén közösek, és a szülő / tanár is látja őket. Internet nélkül az eredmények
   sorban várnak (szorzo_outbox), és a következő kapcsolatkor feltöltődnek.

   Egy eszközt több gyerek is használhat (közös tablet): mindegyiket a saját kódjával kötik össze, és
   induláskor a gyerek kiválasztja magát. A gyakorló app mindig a közös kulcsokat olvassa
   (szorzo_facts, szorzo_history): ezekben az éppen gyakorló gyerek adatai vannak, a többieké
   gyerekenként félretéve (szorzo_facts:<id>, szorzo_history:<id>). */

const CLOUD_CHILDREN_KEY = 'szorzo_children'; // [{ id, nickname, avatar, pin_hash }]
const CLOUD_ACTIVE_KEY = 'szorzo_active_child'; // az éppen gyakorló gyerek azonosítója
const CLOUD_OUTBOX_KEY = 'szorzo_outbox'; // { answers: [], sessions: [] }
const CLOUD_SYNC_KEY = 'szorzo_last_sync';
const CHILD_CACHE_KEYS = ['szorzo_facts', 'szorzo_history', 'szorzo_assignments', 'szorzo_stars'];
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

const cloudOutbox = () => cloudRead(CLOUD_OUTBOX_KEY, { answers: [], sessions: [] });

// Az eszközhöz kötött gyerekek (az 1.2-es, egy gyerekes formátumot átalakítja)
function linkedChildren() {
    const old = cloudRead('szorzo_child', null);
    if (old) {
        cloudWrite(CLOUD_CHILDREN_KEY, [old]);
        cloudWrite(CLOUD_ACTIVE_KEY, old.id);
        localStorage.removeItem('szorzo_child');
    }
    return cloudRead(CLOUD_CHILDREN_KEY, []);
}

// Az éppen gyakorló gyerek (vagy null, ha az eszköz nincs összekötve)
function linkedChild() {
    const children = linkedChildren();
    const activeId = cloudRead(CLOUD_ACTIVE_KEY, null);
    return children.find(c => c.id === activeId) || null;
}

// Gyerekváltás: a mostani gyerek helyi adatai félre, az új gyereké elő
function selectChild(id) {
    const active = cloudRead(CLOUD_ACTIVE_KEY, null);
    if (active === id) return;
    if (active) {
        CHILD_CACHE_KEYS.forEach(k => {
            const v = localStorage.getItem(k);
            if (v === null) localStorage.removeItem(`${k}:${active}`);
            else localStorage.setItem(`${k}:${active}`, v);
        });
    }
    CHILD_CACHE_KEYS.forEach(k => {
        const v = id ? localStorage.getItem(`${k}:${id}`) : null;
        if (v === null) localStorage.removeItem(k);
        else localStorage.setItem(k, v);
        if (id) localStorage.removeItem(`${k}:${id}`);
    });
    if (id) cloudWrite(CLOUD_ACTIVE_KEY, id);
    else localStorage.removeItem(CLOUD_ACTIVE_KEY);
}

function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// A gyerek-PIN ellenőrzése az eszközön (internet nélkül is): sha256("<gyerek azonosító>:<PIN>")
async function childPinMatches(child, pin) {
    const bytes = new TextEncoder().encode(`${child.id}:${pin}`);
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map(x => x.toString(16).padStart(2, '0')).join('');
    return hash === child.pin_hash;
}

// Egy megválaszolt feladat sorba állítása (csak összekötött eszközön, az éppen gyakorló gyereknek)
function cloudQueueAnswer(q, outcome, ms, mode, sessionId) {
    const child = linkedChild();
    if (!child) return;
    const box = cloudOutbox();
    box.answers.push({
        id: newId(), child_id: child.id, op: q.op, tbl: q.table, other: q.other, outcome,
        ms: ms == null ? null : Math.round(ms), mode, session_id: sessionId,
        answered_at: new Date().toISOString(),
    });
    cloudWrite(CLOUD_OUTBOX_KEY, box);
}

// Egy befejezett teszt összesítője, utána rögtön szinkron
function cloudQueueSession(session) {
    const child = linkedChild();
    if (!child) return;
    const box = cloudOutbox();
    box.sessions.push({ child_id: child.id, ...session });
    cloudWrite(CLOUD_OUTBOX_KEY, box);
    cloudSync();
}

// Feltöltés, majd az éppen gyakorló gyerek összesített statisztikájának letöltése (minden eszközéről).
// Visszatérés: true = sikerült, false = nincs összekötve / nincs internet / hiba.
function cloudSync() {
    if (!linkedChildren().length || !navigator.onLine || !cloud()) return Promise.resolve(false);
    if (cloudSyncing) return cloudSyncing;
    cloudSyncing = (async () => {
        try {
            const { data: { session } } = await cloud().auth.getSession();
            if (!session) {
                cloudForget('Az eszköz kapcsolata megszűnt. Kérj új kódot a szülőtől vagy a tanártól!');
                return false;
            }
            // Mely gyerekekhez van még kötve? (a szülő leválaszthatta az eszközt)
            const { data: links, error: linkError } = await cloud().from('child_devices')
                .select('child_id').eq('user_id', session.user.id);
            if (linkError) throw linkError;
            const linkedIds = new Set(links.map(l => l.child_id));
            const removed = linkedChildren().filter(c => !linkedIds.has(c.id));
            removed.forEach(c => cloudRemoveChildLocally(c.id));
            if (removed.length && typeof showToast === 'function') {
                showToast(`☁️ Leválasztva erről az eszközről: ${removed.map(c => c.nickname).join(', ')}`);
            }
            if (!linkedChildren().length) {
                await cloud().auth.signOut();
                return false;
            }

            // Feltöltés (az 1.2-es sorban még nincs gyerek: az akkori egyetlen gyereké)
            const fallbackChild = cloudRead(CLOUD_ACTIVE_KEY, null);
            const box = cloudOutbox();
            const forLinked = rows => rows.map(r => ({ ...r, child_id: r.child_id || fallbackChild }))
                .filter(r => linkedIds.has(r.child_id));
            const answers = forLinked(box.answers);
            const sessions = forLinked(box.sessions);
            const sentAnswers = new Set();
            const sentSessions = new Set();
            for (let i = 0; i < answers.length; i += CLOUD_UPLOAD_BATCH) {
                const rows = answers.slice(i, i + CLOUD_UPLOAD_BATCH);
                const { error } = await cloud().from('answers').upsert(rows, { onConflict: 'id', ignoreDuplicates: true });
                if (error) throw error;
                rows.forEach(r => sentAnswers.add(r.id));
            }
            if (sessions.length) {
                const { error } = await cloud().from('quiz_sessions').upsert(sessions, { onConflict: 'id', ignoreDuplicates: true });
                if (error) throw error;
                sessions.forEach(r => sentSessions.add(r.id));
            }
            // Közben érkezhetett új eredmény: csak a feltöltötteket (és a leválasztott gyerekekét) vesszük ki
            const rest = cloudOutbox();
            const keep = (r, sent) => !sent.has(r.id) && linkedIds.has(r.child_id || fallbackChild);
            rest.answers = rest.answers.filter(a => keep(a, sentAnswers));
            rest.sessions = rest.sessions.filter(s => keep(s, sentSessions));
            cloudWrite(CLOUD_OUTBOX_KEY, rest);

            await cloud().rpc('touch_device');
            await cloudRefreshChildren([...linkedIds]);
            const active = linkedChild();
            if (active && !rest.answers.some(a => a.child_id === active.id)) await cloudPull(active.id);
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

// A gyerekek neve, avatarja és PIN-je (a szülő módosíthatta)
async function cloudRefreshChildren(ids) {
    const { data, error } = await cloud().from('children').select('id, nickname, avatar, pin_hash').in('id', ids);
    if (error) throw error;
    const fresh = new Map(data.map(c => [c.id, c]));
    cloudWrite(CLOUD_CHILDREN_KEY, linkedChildren().map(c => fresh.get(c.id) || c));
}

// A felhőben lévő összesítés lesz a helyi statisztika (feladat-térkép, hibák gyakorlása, grafikon)
async function cloudPull(childId) {
    const { data: facts, error } = await cloud().rpc('child_facts', { p_child_id: childId });
    if (error) throw error;
    const { data: sessions, error: sessionError } = await cloud().from('quiz_sessions')
        .select('pct, mode, finished_at').eq('child_id', childId)
        .order('finished_at', { ascending: false }).limit(20);
    if (sessionError) throw sessionError;
    const assignments = await cloudFetchAssignments(childId);
    const { data: stars, error: starError } = await cloud().rpc('child_stars', { p_child_id: childId });
    if (starError) console.warn('Csillagok:', starError);
    if (cloudRead(CLOUD_ACTIVE_KEY, null) !== childId) return; // közben gyereket váltottak
    cloudWrite('szorzo_facts', factsFromCloud(facts));
    cloudWrite('szorzo_history', historyFromCloud(sessions));
    cloudWrite('szorzo_assignments', assignments);
    if (stars) {
        // seen: a már megmutatott ajándékok, celebrated: a már megünnepelt célok. Az első letöltéskor a régiek
        // nem ugranak fel.
        const old = cloudRead('szorzo_stars', null);
        cloudWrite('szorzo_stars', {
            ...stars,
            seen: old && old.seen ? old.seen : stars.grants.map(g => g.id),
            celebrated: old && old.celebrated ? old.celebrated
                : stars.goals.filter(g => g.progress >= g.target).map(g => g.id),
        });
    }
}

// Befejezett teszt csillagai helyben, rögtön (a következő szinkron a felhőben számoltat hozza). Visszatérés: hány csillag.
function cloudAddStars(session, firstTryOfAssignment) {
    if (!linkedChild()) return 0;
    const n = sessionStars(session, firstTryOfAssignment);
    const stars = cloudRead('szorzo_stars', null);
    if (n && stars) {
        stars.total += n;
        stars.goals.forEach(g => { if (!g.redeemed_at) g.progress = Math.min(g.target, g.progress + n); });
        cloudWrite('szorzo_stars', stars);
    }
    return n;
}

// A gyerek csoportjainak kiosztott feladatai (a csoportnak vagy csak neki), jelölve, melyiket csinálta már meg
async function cloudFetchAssignments(childId) {
    const { data: links, error } = await cloud().from('child_groups').select('group_id').eq('child_id', childId);
    if (error) throw error;
    if (!links.length) return [];
    const { data: tasks, error: taskError } = await cloud().from('assignments')
        .select('id, op, tables, mode, question_count, due_date, note, created_at')
        .in('group_id', links.map(l => l.group_id)).or(`child_id.is.null,child_id.eq.${childId}`)
        .order('created_at', { ascending: false });
    if (taskError) throw taskError;
    const { data: done, error: doneError } = await cloud().from('quiz_sessions')
        .select('assignment_id').eq('child_id', childId).not('assignment_id', 'is', null);
    if (doneError) throw doneError;
    const doneIds = new Set(done.map(d => d.assignment_id));
    // ami még nem ment fel, de már megcsinálta (internet nélkül), az is kész
    cloudOutbox().sessions.forEach(s => { if (s.child_id === childId && s.assignment_id) doneIds.add(s.assignment_id); });
    return tasks.map(t => ({ ...t, done: doneIds.has(t.id) }));
}

// A gyerek megcsinált egy feladatot: helyben rögtön kész (a felhőbe a teszttel együtt kerül fel)
function cloudMarkAssignmentDone(assignmentId) {
    const list = cloudRead('szorzo_assignments', []);
    cloudWrite('szorzo_assignments', list.map(a => (a.id === assignmentId ? { ...a, done: true } : a)));
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

// Összekötés a szülőtől / tanártól kapott kóddal (további gyerek is köthető ugyanahhoz az eszközhöz).
// importLocal: az összekötés előtt az eszközön gyűjtött eredmények is az első gyerekhez kerülnek.
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

    const children = linkedChildren();
    const first = !children.length;
    const child = { id: data.id, nickname: data.nickname, avatar: data.avatar, pin_hash: data.pin_hash || null };
    cloudWrite(CLOUD_CHILDREN_KEY, [...children.filter(c => c.id !== child.id), child]);
    if (first) {
        // az eddigi helyi adatok ennek a gyereknek az adatai lesznek (ha átvesszük), különben tiszta lap
        if (!importLocal) CHILD_CACHE_KEYS.forEach(k => localStorage.removeItem(k));
        cloudWrite(CLOUD_ACTIVE_KEY, child.id);
        if (importLocal) cloudImportLocal(child.id);
    } else {
        selectChild(child.id);
    }
    await cloudSync();
    return child;
}

// Az összekötés előtt helyben gyűjtött eredmények sorba állítása (feladatonként a legutóbbi 5 válasz és a tesztek)
function cloudImportLocal(childId) {
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
                id: newId(), child_id: childId, op, tbl: +tbl, other: +other, outcome, ms, mode: null, session_id: null,
                answered_at: new Date(now - (outcomes.length - i) * 1000).toISOString(), imported: true,
            });
        });
    }
    history.forEach((h, i) => {
        const at = h.at ? new Date(h.at) : new Date(now - (history.length - i) * 60000);
        box.sessions.push({
            id: newId(), child_id: childId, mode: ['practice', 'exam', 'weak'].includes(h.mode) ? h.mode : 'practice',
            pct: h.pct, finished_at: (isNaN(at) ? new Date(now) : at).toISOString(), imported: true,
        });
    });
    cloudWrite(CLOUD_OUTBOX_KEY, box);
}

// Egy gyerek leválasztása erről az eszközről (a felhőben lévő eredményei megmaradnak)
async function cloudUnlink(childId) {
    try {
        await cloudSync(); // ami még nem ment fel, előbb felmegy
        const { data: { session } } = await cloud().auth.getSession();
        if (session) await cloud().from('child_devices').delete().eq('user_id', session.user.id).eq('child_id', childId);
        if (linkedChildren().length <= 1 && session) await cloud().auth.signOut();
    } catch (e) {
        console.warn('Leválasztási hiba:', e);
    }
    cloudRemoveChildLocally(childId);
}

// A gyerek helyi nyomainak törlése erről az eszközről; ha ő gyakorolt, egy másik gyerek (vagy senki) jön
function cloudRemoveChildLocally(childId) {
    const rest = linkedChildren().filter(c => c.id !== childId);
    CHILD_CACHE_KEYS.forEach(k => localStorage.removeItem(`${k}:${childId}`));
    const box = cloudOutbox();
    box.answers = box.answers.filter(a => a.child_id && a.child_id !== childId);
    box.sessions = box.sessions.filter(s => s.child_id && s.child_id !== childId);
    cloudWrite(CLOUD_OUTBOX_KEY, box);
    if (cloudRead(CLOUD_ACTIVE_KEY, null) === childId) {
        CHILD_CACHE_KEYS.forEach(k => localStorage.removeItem(k));
        localStorage.removeItem(CLOUD_ACTIVE_KEY);
        if (rest.length) {
            cloudWrite(CLOUD_CHILDREN_KEY, rest);
            selectChild(rest[0].id);
        }
    }
    if (rest.length) {
        cloudWrite(CLOUD_CHILDREN_KEY, rest);
    } else {
        [CLOUD_CHILDREN_KEY, CLOUD_ACTIVE_KEY, CLOUD_OUTBOX_KEY, CLOUD_SYNC_KEY].forEach(k => localStorage.removeItem(k));
    }
}

// Minden összekötés helyi nyomának törlése (a gyerekek statisztikája a felhőben marad)
function cloudForget(reason) {
    linkedChildren().forEach(c => cloudRemoveChildLocally(c.id));
    CHILD_CACHE_KEYS.forEach(k => localStorage.removeItem(k));
    if (reason && typeof showToast === 'function') showToast(`☁️ ${reason}`);
}
