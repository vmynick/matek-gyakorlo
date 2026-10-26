/* Szorzótábla Mester – szülői / tanári felület.
   Belépés e-mailes linkkel (csak meghívottaknak), csoportok (család / osztály), gyerekek, eszköz-kódok,
   meghívások és a gyerekek statisztikája. Hogy ki mit láthat és tehet, azt az adatbázis szabályai döntik el;
   itt csak a felület van. */

const CONSOLE_URL = location.origin + location.pathname;
const APP_ROOT = new URL('./', CONSOLE_URL).href;
const AVATARS = ['🦊', '🐼', '🐸', '🐯', '🦁', '🐨', '🐰', '🐻', '🦄', '🐙', '🐱', '🐶', '🐧', '🐢', '🦉', '🐝'];

// A felnőtt munkamenete külön kulcson van, mint a gyerek eszközéé (ugyanazon a gépen sem keverednek)
const sb = window.supabase.createClient(CLOUD_CONFIG.url, CLOUD_CONFIG.key, {
    auth: { storageKey: 'szorzo-felnott-auth', persistSession: true, autoRefreshToken: true,
            detectSessionInUrl: true, flowType: 'implicit' },
});
// A meghívó levelét külön, munkamenet nélküli kliens küldi, hogy a saját belépésünket ne érintse
const mailer = window.supabase.createClient(CLOUD_CONFIG.url, CLOUD_CONFIG.key, {
    auth: { storageKey: 'szorzo-meghivo', persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

let me = null; // { id, email, is_admin, can_create_groups }
let groups = [];
let currentChild = null;
let childFacts = {};
let childHeatmapOp = 'mul';
let childChart = null;
let lastCode = null;

const VIEWS = ['loading', 'view-login', 'view-noaccess', 'view-home', 'view-child'];
function show(id) {
    VIEWS.forEach(v => { document.getElementById(v).hidden = v !== id; });
    window.scrollTo(0, 0);
}

let toastTimer = null;
function toast(message) {
    const el = document.getElementById('toast');
    el.innerText = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

function fail(error) {
    console.error(error);
    toast(`⚠️ ${error.message || error}`);
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function whenText(iso) {
    if (!iso) return 'még nem használta';
    const d = new Date(iso);
    const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
    const time = d.toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' });
    if (days <= 0) return `ma ${time}`;
    if (days === 1) return `tegnap ${time}`;
    return days < 7 ? `${days} napja` : d.toLocaleDateString('hu-HU', { month: 'short', day: 'numeric' });
}

function lastSeen(child) {
    const times = (child.child_devices || []).map(d => d.last_seen).sort();
    return times.length ? `utoljára ${whenText(times[times.length - 1])}` : 'nincs összekötött eszköz';
}

/* ---------- Belépés ---------- */

async function init() {
    // A belépő link hibája (pl. lejárt) a címben érkezik
    const hash = new URLSearchParams(location.hash.slice(1));
    const linkError = hash.get('error_description');

    const { data: { session } } = await sb.auth.getSession();
    if (session) {
        await enter(session);
    } else {
        show('view-login');
        if (linkError) {
            setMsg('login-msg', 'error', `A belépő link nem működött (${linkError}). Kérj újat!`);
            history.replaceState(null, '', CONSOLE_URL);
        }
    }
    sb.auth.onAuthStateChange((event, newSession) => {
        if (event === 'SIGNED_IN' && newSession && !me) enter(newSession);
    });
}

function setMsg(id, kind, text) {
    const el = typeof id === 'string' ? document.getElementById(id) : id;
    if (!el) return;
    el.className = `msg ${kind || ''}`;
    el.innerText = text;
}

async function sendLoginLink(event) {
    event.preventDefault();
    const email = document.getElementById('login-email').value.trim().toLowerCase();
    const btn = document.getElementById('login-btn');
    btn.disabled = true;
    setMsg('login-msg', '', 'Küldés…');
    const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: CONSOLE_URL } });
    btn.disabled = false;
    if (error) {
        setMsg('login-msg', 'error', error.message.includes('meghívó') ? error.message : `Nem sikerült: ${error.message}`);
    } else {
        setMsg('login-msg', 'ok', `Elküldtük a belépő linket ide: ${email}. Nézd meg a leveleidet (a Spam mappát is)!`);
    }
}

async function enter(session) {
    show('loading');
    document.getElementById('who-email').innerText = session.user.email;
    document.getElementById('who').hidden = false;
    const { data, error } = await sb.rpc('accept_invitations');
    if (error) return fail(error);
    if (!data.adult) {
        show('view-noaccess');
        return;
    }
    await loadHome();
}

async function logout() {
    await sb.auth.signOut();
    me = null;
    document.getElementById('who').hidden = true;
    show('view-login');
}

/* ---------- Kezdőlap: csoportok ---------- */

async function loadHome() {
    const { data: { user } } = await sb.auth.getUser();
    const { data: adult, error } = await sb.from('adults')
        .select('id, email, is_admin, can_create_groups').eq('id', user.id).single();
    if (error) return fail(error);
    me = adult;

    const { data, error: groupError } = await sb.from('groups').select(`
        id, name, kind,
        group_members ( adult_id, role, adults ( email ) ),
        child_groups ( children ( id, nickname, avatar, pin_hash, child_devices ( last_seen ) ) )`).order('created_at');
    if (groupError) return fail(groupError);
    groups = data;
    renderHome();
    show('view-home');
}

function showHome() {
    currentChild = null;
    loadHome();
}

function renderHome() {
    const wrap = document.getElementById('groups');
    wrap.innerHTML = '';
    const canCreate = me.can_create_groups || me.is_admin;
    if (!groups.length) {
        wrap.innerHTML = `<section class="card"><h2>👋 Üdv!</h2><p class="muted">${canCreate
            ? 'Hozz létre lent egy csoportot (családot vagy osztályt), és add hozzá a gyerekeket.'
            : 'Még nem vagy egy csoportnak sem a tagja. Kérj meghívót egy csoport tulajdonosától.'}</p></section>`;
    }
    groups.forEach(g => wrap.appendChild(groupCard(g)));
    document.getElementById('new-group-card').hidden = !canCreate;
    document.getElementById('admin-card').hidden = !me.is_admin;
    loadPending();
}

function groupCard(g) {
    const isOwner = g.group_members.some(m => m.adult_id === me.id && m.role === 'owner');
    const children = g.child_groups.map(cg => cg.children).filter(Boolean)
        .sort((a, b) => a.nickname.localeCompare(b.nickname, 'hu'));
    const card = document.createElement('section');
    card.className = 'card';
    card.innerHTML = `
        <h2>${g.kind === 'class' ? '🏫' : '🏠'} ${esc(g.name)} <span class="muted">${isOwner ? 'tulajdonos' : 'tag'}</span></h2>
        <div class="chips">${children.map(c => `
            <button class="child-btn" data-child="${c.id}">
                <strong>${esc(c.avatar)} ${esc(c.nickname)}</strong><span>${esc(lastSeen(c))}</span>
            </button>`).join('') || '<span class="muted">Még nincs gyerek a csoportban.</span>'}</div>
        <details class="add-child-box">
            <summary>➕ Gyerek hozzáadása</summary>
            <form class="add-child">
                <input name="nickname" required maxlength="30" placeholder="Becenév (pl. Bori)">
                <button class="btn">Hozzáadás</button>
            </form>
            <div class="avatars">${AVATARS.map((a, i) => `<button type="button" data-avatar="${a}" class="${i ? '' : 'selected'}">${a}</button>`).join('')}</div>
            <p class="muted">Csak becenevet adj meg, valódi nevet ne.</p>
        </details>
        <details>
            <summary>👥 Felnőttek (${g.group_members.length})</summary>
            <ul class="members">${g.group_members.map(m => `
                <li><span>${esc(m.adults ? m.adults.email : '?')}</span><span class="muted">${m.role === 'owner' ? 'tulajdonos' : 'tag'}</span></li>`).join('')}
            </ul>
            ${isOwner ? `
            <form class="invite">
                <input type="email" name="email" required placeholder="szulo@pelda.hu">
                <select name="role">
                    <option value="member">tag: látja a csoport gyerekeit</option>
                    <option value="owner">tulajdonos: meghívhat is</option>
                </select>
                <button class="btn">Meghívás</button>
            </form>
            <p class="msg"></p>` : ''}
        </details>`;

    card.querySelectorAll('.child-btn').forEach(btn => { btn.onclick = () => openChild(btn.dataset.child); });

    let avatar = AVATARS[0];
    card.querySelectorAll('.avatars button').forEach(btn => {
        btn.onclick = () => {
            avatar = btn.dataset.avatar;
            card.querySelectorAll('.avatars button').forEach(b => b.classList.toggle('selected', b === btn));
        };
    });
    card.querySelector('.add-child').onsubmit = async (event) => {
        event.preventDefault();
        const nickname = event.target.nickname.value.trim();
        const { error } = await sb.rpc('create_child', { p_group_id: g.id, p_nickname: nickname, p_avatar: avatar });
        if (error) return fail(error);
        toast(`✅ ${avatar} ${nickname} hozzáadva`);
        loadHome();
    };

    const invite = card.querySelector('.invite');
    if (invite) {
        invite.onsubmit = async (event) => {
            event.preventDefault();
            await inviteAdult(invite.email.value, g.id, invite.role.value, false, invite.nextElementSibling);
        };
    }
    return card;
}

async function createGroup(event) {
    event.preventDefault();
    const name = document.getElementById('group-name').value.trim();
    const kind = document.getElementById('group-kind').value;
    const { error } = await sb.rpc('create_group', { p_name: name, p_kind: kind });
    if (error) return fail(error);
    document.getElementById('group-name').value = '';
    toast(`✅ Csoport létrehozva: ${name}`);
    loadHome();
}

/* ---------- Meghívás ---------- */

// A meghívó bekerül az adatbázisba (ettől regisztrálhat), aztán a meghívott belépő linket kap e-mailben
async function inviteAdult(rawEmail, groupId, role, canCreateGroups, msgEl) {
    const email = rawEmail.trim().toLowerCase();
    setMsg(msgEl, '', 'Meghívás…');
    const { data: result, error } = await sb.rpc('invite_adult',
        { p_email: email, p_group_id: groupId, p_group_role: role, p_can_create_groups: canCreateGroups });
    if (error) {
        setMsg(msgEl, 'error', error.message);
        return;
    }
    if (result === 'added') {
        toast(`✅ ${email} már regisztrált: hozzáadtuk`);
        loadHome();
        return;
    }
    const { error: mailError } = await mailer.auth.signInWithOtp(
        { email, options: { shouldCreateUser: true, emailRedirectTo: CONSOLE_URL } });
    if (mailError) {
        setMsg(msgEl, 'error', `A meghívó elkészült, de a levél nem ment el (${mailError.message}). ` +
            `A meghívott maga is kérhet belépő linket itt: ${CONSOLE_URL}`);
    } else {
        setMsg(msgEl, 'ok', `Meghívó elküldve: ${email}`);
        toast(`✉️ Meghívó elküldve: ${email}`);
    }
    loadPending();
}

function inviteCreator(event) {
    event.preventDefault();
    inviteAdult(document.getElementById('creator-email').value, null, 'member', true, document.getElementById('creator-msg'));
}

async function loadPending() {
    const { data, error } = await sb.from('invitations')
        .select('id, email, created_at, groups ( name )').is('accepted_at', null).order('created_at', { ascending: false });
    const card = document.getElementById('pending-card');
    if (error || !data.length) {
        card.hidden = true;
        return;
    }
    card.hidden = false;
    const list = document.getElementById('pending-list');
    list.innerHTML = data.map(inv => `
        <li><span>${esc(inv.email)} <span class="muted">${inv.groups ? '→ ' + esc(inv.groups.name) : '(saját csoporttal)'} · ${esc(whenText(inv.created_at))}</span></span>
            <button class="link" data-id="${inv.id}">visszavonás</button></li>`).join('');
    list.querySelectorAll('button').forEach(btn => {
        btn.onclick = async () => {
            const { error: delError } = await sb.from('invitations').delete().eq('id', btn.dataset.id);
            if (delError) return fail(delError);
            loadPending();
        };
    });
}

/* ---------- Egy gyerek ---------- */

async function openChild(id) {
    const inGroups = groups.filter(g => g.child_groups.some(cg => cg.children && cg.children.id === id));
    const child = inGroups[0].child_groups.find(cg => cg.children && cg.children.id === id).children;
    currentChild = {
        id, nickname: child.nickname, avatar: child.avatar, history: [], hasPin: !!child.pin_hash,
        owner: inGroups.some(g => g.group_members.some(m => m.adult_id === me.id && m.role === 'owner')),
    };
    renderPinStatus();
    lastCode = null;
    show('loading');
    document.getElementById('child-avatar').innerText = child.avatar;
    document.getElementById('child-name').innerText = child.nickname;
    document.getElementById('child-groups').innerText = `Csoport: ${inGroups.map(g => g.name).join(', ')}`;
    document.getElementById('delete-child-btn').hidden = !currentChild.owner;
    document.getElementById('code-box').hidden = true;
    try {
        await Promise.all([loadChildStats(), loadDevices()]);
    } catch (e) {
        return fail(e);
    }
    show('view-child');
    renderChildStats(); // a grafikonnak látható vászon kell
}

async function loadChildStats() {
    const [factsRes, sessionsRes] = await Promise.all([
        sb.rpc('child_facts', { p_child_id: currentChild.id }),
        sb.from('quiz_sessions').select('pct, mode, finished_at').eq('child_id', currentChild.id)
            .order('finished_at', { ascending: false }).limit(20),
    ]);
    if (factsRes.error) throw factsRes.error;
    if (sessionsRes.error) throw sessionsRes.error;
    childFacts = factsFromCloud(factsRes.data);
    currentChild.history = historyFromCloud(sessionsRes.data);
}

function renderChildStats() {
    childChart = buildProgressChart(document.getElementById('child-chart'), currentChild.history, childChart);
    renderHeatmapGrid(document.getElementById('child-heatmap'), document.getElementById('child-hm-detail'), childFacts, childHeatmapOp);
    const facts = Object.values(childFacts);
    const answers = facts.reduce((s, f) => s + f.n, 0);
    const weak = facts.filter(isWeak).length;
    document.getElementById('child-summary').innerText = answers
        ? `${currentChild.history.length} teszt · ${answers} megválaszolt feladat · 🎯 ${weak} feladat vár gyakorlásra`
        : 'Még nincs eredmény. Kösd össze a gyerek eszközét egy kóddal, és ha gyakorol, itt látszik.';
}

function setChildHeatmapOp(op, btn) {
    childHeatmapOp = op;
    btn.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('selected', b === btn));
    renderHeatmapGrid(document.getElementById('child-heatmap'), document.getElementById('child-hm-detail'), childFacts, op);
}

async function loadDevices() {
    const { data, error } = await sb.from('child_devices')
        .select('user_id, linked_at, last_seen').eq('child_id', currentChild.id).order('linked_at');
    if (error) throw error;
    const list = document.getElementById('device-list');
    list.innerHTML = data.map((d, i) => `
        <li><span>📱 ${i + 1}. eszköz <span class="muted">· összekötve ${esc(whenText(d.linked_at))} · utoljára ${esc(whenText(d.last_seen))}</span></span>
            <button class="link" data-user="${d.user_id}">leválasztás</button></li>`).join('')
        || '<li class="muted">Még nincs összekötött eszköz.</li>';
    list.querySelectorAll('button').forEach(btn => {
        btn.onclick = async () => {
            if (!confirm(`Leválasztod ezt az eszközt ${currentChild.nickname} profiljáról? Az eddigi eredmények megmaradnak.`)) return;
            // csak ennek a gyereknek a kapcsolata: közös tableten a többi gyerek összekötve marad
            const { error: delError } = await sb.from('child_devices').delete()
                .eq('user_id', btn.dataset.user).eq('child_id', currentChild.id);
            if (delError) return fail(delError);
            toast('📱 Eszköz leválasztva');
            loadDevices().catch(fail);
        };
    });
}

async function newDeviceCode() {
    const { data, error } = await sb.rpc('create_device_code', { p_child_id: currentChild.id });
    if (error) return fail(error);
    lastCode = data.code;
    document.getElementById('code-value').innerText = data.code;
    document.getElementById('code-expiry').innerText =
        `Érvényes eddig: ${new Date(data.expires_at).toLocaleString('hu-HU', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
    document.getElementById('code-box').hidden = false;
}

// A kódot linkként is el lehet küldeni a gyerek eszközére: ott megnyitva a kód már be van írva
async function shareDeviceCode() {
    if (!lastCode) return;
    const url = `${APP_ROOT}?kod=${lastCode}`;
    const text = `${currentChild.nickname} eszközének összekötése a Szorzótábla Mesterrel (a link 24 óráig érvényes):`;
    if (navigator.share) {
        try {
            await navigator.share({ title: 'Szorzótábla Mester – összekötés', text, url });
        } catch (e) { /* bezárta a megosztó menüt */ }
        return;
    }
    try {
        await navigator.clipboard.writeText(url);
        toast('🔗 A link a vágólapra került');
    } catch (e) {
        toast(url);
    }
}

/* ---------- Gyerek-PIN (közös tableten a testvérek ne egymás nevében gyakoroljanak) ---------- */

function renderPinStatus() {
    setMsg('pin-status', currentChild.hasPin ? 'ok' : '',
        currentChild.hasPin ? '🔒 Be van kapcsolva: a gyerek a PIN-jével választja ki magát.' : 'Nincs PIN: elég az avatarra koppintani.');
    document.getElementById('pin-remove-btn').hidden = !currentChild.hasPin;
    document.getElementById('child-pin').value = '';
}

async function setChildPin(event) {
    event.preventDefault();
    const pin = document.getElementById('child-pin').value.trim();
    if (!/^[0-9]{4}$/.test(pin)) return toast('A PIN pontosan 4 számjegy');
    const { error } = await sb.rpc('set_child_pin', { p_child_id: currentChild.id, p_pin: pin });
    if (error) return fail(error);
    currentChild.hasPin = true;
    renderPinStatus();
    toast(`🔒 ${currentChild.nickname} PIN-je beállítva`);
}

async function removeChildPin() {
    const { error } = await sb.rpc('set_child_pin', { p_child_id: currentChild.id, p_pin: null });
    if (error) return fail(error);
    currentChild.hasPin = false;
    renderPinStatus();
    toast(`🔓 ${currentChild.nickname} PIN-je kikapcsolva`);
}

async function clearChildStats() {
    if (!confirm(`Biztosan törlöd ${currentChild.nickname} összes eredményét? Ez nem vonható vissza.`)) return;
    const { error } = await sb.rpc('clear_child_stats', { p_child_id: currentChild.id });
    if (error) return fail(error);
    toast('🗑️ Statisztika törölve');
    await loadChildStats().catch(fail);
    renderChildStats();
}

async function deleteChild() {
    if (!confirm(`Biztosan törlöd ${currentChild.nickname} profilját? Minden eredménye és eszköz-kapcsolata törlődik.`)) return;
    const { error } = await sb.from('children').delete().eq('id', currentChild.id);
    if (error) return fail(error);
    toast(`🗑️ ${currentChild.nickname} törölve`);
    showHome();
}

init().catch(fail);
