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

const VIEWS = ['loading', 'view-login', 'view-noaccess', 'view-home', 'view-group', 'view-child'];
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
        .select('id, email, is_admin, can_create_groups, can_create_classes').eq('id', user.id).single();
    if (error) return fail(error);
    me = adult;

    const { data, error: groupError } = await sb.from('groups').select(`
        id, name, kind,
        group_members ( adult_id, role, adults ( email ) ),
        child_groups ( children ( id, nickname, avatar, pin_hash, child_devices ( last_seen ) ) )`).order('created_at');
    if (groupError) return fail(groupError);
    groups = data;
    document.getElementById('who-roles').innerHTML = myRoles()
        .map(r => `<span class="badge">${r.label}</span>`).join('') || '<span class="badge">meghívott</span>';
    renderHome();
    show('view-home');
}

// Szerepek (a fejlécben és a Fiók fülön). Szülő: családot hozhat létre, vagy egy család tagja (pl. a másik szülő).
// Tanár: osztályt hozhat létre, vagy egy osztály tanára. Admin: szülőket és tanárokat hív meg.
const isParent = () => me.can_create_groups || groups.some(g => g.kind === 'family');
const isTeacher = () => me.can_create_classes || groups.some(g => g.kind === 'class');

function myRoles() {
    const roles = [];
    if (me.is_admin) roles.push({ label: '🛡️ Admin', what: 'szülőket és tanárokat hívhat meg, jogokat adhat és vonhat meg' });
    if (isParent()) {
        roles.push({ label: '🏠 Szülő', what: me.can_create_groups ? 'családot hozhat létre, gyerekeket vehet fel'
            : 'egy család tagja: látja a család gyerekeit' });
    }
    if (isTeacher()) {
        roles.push({ label: '🏫 Tanár', what: me.can_create_classes ? 'osztályt hozhat létre, szülőket hívhat meg'
            : 'egy osztály tanára: látja az osztály gyerekeit' });
    }
    return roles;
}

function showHome() {
    currentChild = null;
    loadHome();
}

/* A felület a szerephez igazodik: a szülőnek a gyerekei, a tanárnak az osztályai elöl.
   Akinek több szerepe is van (pl. tanár, aki szülő is; admin), felül füllel vált. */
const MODE_TITLES = { family: '👨‍👩‍👧 Szülői felület', class: '🏫 Tanári felület', admin: '🛡️ Admin', account: '👤 Fiókom' };
let consoleMode = null;

function availableModes() {
    const modes = [];
    if (isParent() || (!isTeacher() && !me.is_admin)) modes.push('family');
    if (isTeacher()) modes.push('class');
    if (me.is_admin) modes.push('admin');
    modes.push('account');
    return modes;
}

function setConsoleMode(mode) {
    consoleMode = mode;
    try { localStorage.setItem('szorzo_konzol_mod', mode); } catch (e) { /* csak most vált */ }
    renderHome();
}

function renderHome() {
    const modes = availableModes();
    let saved = null;
    try { saved = localStorage.getItem('szorzo_konzol_mod'); } catch (e) { /* nincs mentett */ }
    if (!modes.includes(consoleMode)) consoleMode = modes.includes(saved) ? saved : modes[0];
    const mode = consoleMode;

    document.getElementById('console-title').innerText = MODE_TITLES[mode];
    document.title = `${MODE_TITLES[mode].replace(/^\S+\s/, '')} – Szorzótábla Mester`;
    document.getElementById('mode-tabs').querySelectorAll('button').forEach(b => {
        b.hidden = !modes.includes(b.dataset.mode);
        b.classList.toggle('active', b.dataset.mode === mode);
    });
    document.getElementById('home-family').hidden = mode !== 'family';
    document.getElementById('home-class').hidden = mode !== 'class';
    document.getElementById('admin-card').hidden = mode !== 'admin';
    document.getElementById('home-account').hidden = mode !== 'account';

    if (mode === 'family') renderFamilyHome();
    if (mode === 'class') renderClassHome();
    if (mode === 'admin') loadAdmin();
    if (mode === 'account') renderAccount();

    // Új csoport: a szülő családot, a tanár osztályt hoz létre (külön jog); amíg nincs egy sem, nyitva van
    const canNew = mode === 'family' ? me.can_create_groups : mode === 'class' ? me.can_create_classes : false;
    document.getElementById('new-group-card').hidden = !canNew;
    document.getElementById('new-group-box').open = canNew && !groups.some(g => g.kind === mode);
    document.getElementById('group-kind').value = mode === 'class' ? 'class' : 'family';
    document.getElementById('new-group-title').innerText = mode === 'class' ? 'Új osztály' : 'Új család';
    document.getElementById('new-group-help').innerText = mode === 'class'
        ? 'a gyerekeket a szülők csatlakozási kóddal teszik be, vagy te veszed fel'
        : 'a saját gyerekeidnek; a másik szülőt utána meghívhatod';
    document.getElementById('group-name').placeholder = mode === 'class' ? 'pl. 3.b' : 'pl. Kovács család';
}

// Fiók fül: kivel van belépve, mit tehet; a meghívói, az adatkezelés és a fiók törlése
function renderAccount() {
    document.getElementById('account-email').innerText = me.email;
    document.getElementById('account-roles').innerHTML = myRoles()
        .map(r => `<li><span class="badge">${r.label}</span> <span class="muted">${r.what}</span></li>`).join('')
        || '<li class="muted">Meghívott felnőtt: azokat a gyerekeket látod, akiknek a csoportjába meghívtak.</li>';
    const owned = groups.filter(g => g.group_members.some(m => m.adult_id === me.id && m.role === 'owner')).length;
    document.getElementById('account-groups').innerText =
        `${groups.length} csoport tagja vagy${owned ? `, ebből ${owned} tulajdonosa` : ''}.`;
    const privacy = document.getElementById('privacy-account');
    if (!privacy.childElementCount) privacy.innerHTML = document.getElementById('privacy-text').innerHTML;
    loadPending();
}

// Szülő: nagy kártyák a gyerekekről (mikor gyakorolt, mi vár gyakorlásra, kiosztott feladatok), alatta a családok
function renderFamilyHome() {
    const families = groups.filter(g => g.kind === 'family');
    const kids = new Map();
    families.forEach(g => g.child_groups.forEach(cg => { if (cg.children) kids.set(cg.children.id, cg.children); }));
    const box = document.getElementById('my-children');
    const sorted = [...kids.values()].sort((a, b) => a.nickname.localeCompare(b.nickname, 'hu'));
    box.innerHTML = sorted.map(c => `
        <button class="kid-card child-btn" data-child="${c.id}">
            <span class="kid-avatar">${esc(c.avatar)}</span>
            <span class="kid-name">${esc(c.nickname)}</span>
            <span class="kid-meta" data-meta="${c.id}">${esc(lastSeen(c))}</span>
        </button>`).join('') || `<p class="muted">${families.length
            ? 'Még nincs gyerek. Lent, a családodnál add hozzá („Gyerek hozzáadása”).'
            : 'Hozz létre lent egy családot, és vedd fel a gyerekeidet. Ha a tanár adott csatlakozási kódot, azt a gyereked oldalán írd be.'}</p>`;
    box.querySelectorAll('[data-child]').forEach(b => { b.onclick = () => openChild(b.dataset.child); });

    const wrap = document.getElementById('family-groups');
    wrap.innerHTML = '';
    families.forEach(g => wrap.appendChild(groupCard(g, 'family')));

    // Részletek a kártyákra (a háttérben): az elmúlt hét, gyakorlásra váró, nyitott feladatok
    families.forEach(async g => {
        const { data } = await sb.rpc('group_children_summary', { p_group_id: g.id });
        for (const s of data || []) {
            const meta = box.querySelector(`[data-meta="${s.child_id}"]`);
            if (!meta) continue;
            const { data: tasks } = await sb.rpc('child_assignments', { p_child_id: s.child_id });
            const open = (tasks || []).filter(t => !t.done && (!t.due_date || new Date(`${t.due_date}T23:59:59`) > new Date())).length;
            meta.innerText = `⭐ ${s.stars ?? 0} · az elmúlt 7 napban ${s.answers_7d} feladat` +
                (s.weak ? ` · 🎯 ${s.weak} gyakorlásra vár` : '') +
                (open ? ` · 📌 ${open} kiosztott feladat` : '') +
                ` · ${s.last_answer ? `utoljára ${whenText(s.last_answer)}` : 'még nem gyakorolt'}`;
        }
    });
}

// Tanár: osztálykártyák rövid összegzéssel
function renderClassHome() {
    const classes = groups.filter(g => g.kind === 'class');
    const wrap = document.getElementById('class-groups');
    wrap.innerHTML = classes.length ? '' : `<section class="card"><h2>👋 Üdv!</h2><p class="muted">${
        me.can_create_classes ? 'Hozz létre lent egy osztályt. Utána a szülőknek csatlakozási kódot adhatsz.'
            : 'Még nem vagy egy osztálynak sem a tagja.'}</p></section>`;
    classes.forEach(g => wrap.appendChild(groupCard(g, 'class')));
    classes.forEach(async g => {
        const { data } = await sb.rpc('group_children_summary', { p_group_id: g.id });
        const el = wrap.querySelector(`[data-summary="${g.id}"]`);
        if (!el || !data) return;
        const active = data.filter(s => s.answers_7d > 0).length;
        const needHelp = data.filter(s => s.weak > 0).length;
        el.innerText = `👧 ${data.length} gyerek · ✅ ${active} gyakorolt a héten · 🎯 ${needHelp} gyereknek van gyakorlásra váró feladata`;
    });
}

// Egy beállítás sora: ikon, cím, alcím (állapot); koppintásra nyílik
function settingItem(icon, title, sub, body, extraClass = '') {
    return `
        <details class="setting ${extraClass}">
            <summary>
                <span class="s-icon">${icon}</span>
                <span class="s-text"><strong>${title}</strong><small>${sub}</small></span>
            </summary>
            <div class="setting-body">${body}</div>
        </details>`;
}

// view: 'family' (a gyerekek fent, kártyán látszanak) vagy 'class' (összegzés és nagy összesítés gomb).
// A csoport beállításai egy összecsukott listában vannak a kártya alján.
function groupCard(g, view) {
    const isOwner = g.group_members.some(m => m.adult_id === me.id && m.role === 'owner');
    const isClass = g.kind === 'class';
    const children = g.child_groups.map(cg => cg.children).filter(Boolean)
        .sort((a, b) => a.nickname.localeCompare(b.nickname, 'hu'));
    const owners = g.group_members.filter(m => m.role === 'owner').length;
    const settings = [];
    if (isOwner && isClass) {
        settings.push(settingItem('🔑', 'Csatlakozási kód szülőknek', 'ezzel teszi be a szülő a gyerekét az osztályba', `
            <p class="muted">A szülő a gyereke oldalán, a „Csatlakozás osztályhoz kóddal” résznél írja be. Bárhány szülő használhatja; új kód kérésekor a régi érvényét veszti.</p>
            <div class="row"><button class="btn secondary" data-act="joincode">🔑 Kód kérése</button></div>
            <div class="code-box join-box" hidden>
                <div class="code"></div>
                <p class="muted"></p>
                <div class="row" style="justify-content:center">
                    <button class="btn secondary" data-act="sharejoin">📤 Kód küldése a szülőknek</button>
                </div>
            </div>`));
        settings.push(settingItem('👪', 'Szülő meghívása', 'belépő linket kap e-mailben, és családot hozhat létre', `
            <p class="muted">A szülő létrehozhatja a saját családját, felveheti a gyerekét, és a csatlakozási kóddal beteheti az osztályba. Az osztály többi gyerekét nem látja.</p>
            <form class="invite-parent row">
                <input type="email" name="email" required placeholder="szulo@pelda.hu">
                <button class="btn">Meghívás</button>
            </form>
            <p class="msg"></p>`));
    }
    settings.push(settingItem('➕', 'Gyerek hozzáadása', 'becenév és avatar', `
        <form class="add-child row">
            <input name="nickname" required maxlength="30" placeholder="Becenév (pl. Bori)">
            <button class="btn">Hozzáadás</button>
        </form>
        <div class="avatars">${AVATARS.map((a, i) => `<button type="button" data-avatar="${a}" class="${i ? '' : 'selected'}">${a}</button>`).join('')}</div>
        <p class="muted">Csak becenevet adj meg, valódi nevet ne.</p>`, 'add-child-box'));
    settings.push(settingItem(isClass ? '🧑‍🏫' : '👪', `${isClass ? 'Tanárok' : 'Családtagok'} (${g.group_members.length})`,
        isClass ? 'az osztály tanárai: mind látják az osztály gyerekeit'
            : 'szülők, nagyszülők: mind látják a család gyerekeit', `
        <p class="muted">${isClass ? 'Tanártársat hívhatsz meg (pl. napközis tanító). A szülőket a „Szülő meghívása” résznél hívd meg: ők a saját családjukban vannak, nem itt.'
            : 'Pl. a másik szülőt vagy a nagyszülőket hívhatod meg.'} A tulajdonos meghívhat és törölhet is.</p>
        <ul class="members">${g.group_members.map(m => memberRow(m, isOwner)).join('')}</ul>
        ${isOwner ? `
        <form class="invite">
            <input type="email" name="email" required placeholder="${isClass ? 'tanar@iskola.hu' : 'masik.szulo@pelda.hu'}">
            <select name="role">
                <option value="member">tag: látja a gyerekeket</option>
                <option value="owner">tulajdonos: meghívhat és törölhet is</option>
            </select>
            <button class="btn">Meghívás</button>
        </form>
        <p class="msg"></p>` : ''}`));
    if (isOwner) {
        settings.push(settingItem('✏️', 'Átnevezés', esc(g.name), `
            <form class="rename row">
                <input name="name" required maxlength="60" value="${esc(g.name)}" aria-label="A csoport neve">
                <button class="btn">Mentés</button>
            </form>`));
        settings.push(settingItem('🗑️', `${isClass ? 'Osztály' : 'Család'} törlése`, 'a csak itt lévő gyerekek eredményei is törlődnek', `
            <p class="muted">Azok a gyerekek, akik csak ebben a csoportban vannak, minden eredményükkel együtt törlődnek. Ez nem vonható vissza.</p>
            <div class="row"><button class="btn danger" data-act="delete">🗑️ ${isClass ? 'Osztály' : 'Család'} törlése</button></div>`, 'danger'));
    }

    const card = document.createElement('section');
    card.className = 'card';
    card.innerHTML = `
        <h2>${isClass ? '🏫' : '🏠'} ${esc(g.name)} <span class="badge">${isOwner ? 'tulajdonos' : 'tag'}</span></h2>
        ${view === 'class' ? `
        <p class="class-summary" data-summary="${g.id}"></p>
        <div class="row"><button class="btn" data-act="overview">📊 Összesítés és feladatok</button></div>
        <div class="chips">${children.map(c => `
            <button class="child-btn" data-child="${c.id}">
                <strong>${esc(c.avatar)} ${esc(c.nickname)}</strong><span>${esc(lastSeen(c))}</span>
            </button>`).join('') || '<span class="muted">Még nincs gyerek az osztályban.</span>'}</div>` : `
        <p class="muted">👧 ${children.length} gyerek · 👥 ${g.group_members.length} felnőtt</p>
        <div class="row"><button class="btn secondary" data-act="overview">📊 Összesítés és feladatok</button></div>`}
        <details class="settings-group"${children.length ? '' : ' open'}>
            <summary>⚙️ ${isClass ? 'Az osztály' : 'A család'} beállításai</summary>
            <div class="settings-list">${settings.join('')}</div>
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

    const act = name => card.querySelector(`[data-act="${name}"]`);
    act('overview').onclick = () => openGroup(g.id);
    const inviteParent = card.querySelector('.invite-parent');
    if (inviteParent) {
        inviteParent.onsubmit = async (event) => {
            event.preventDefault();
            const msgEl = inviteParent.nextElementSibling;
            const email = inviteParent.email.value.trim().toLowerCase();
            setMsg(msgEl, '', 'Meghívás…');
            const { data: result, error } = await sb.rpc('invite_parent', { p_email: email });
            if (error) return setMsg(msgEl, 'error', error.message);
            if (result === 'added') return setMsg(msgEl, 'ok', `${email} már regisztrált: családot hozhat létre.`);
            await sendInviteMail(email, msgEl);
        };
    }

    // Tulajdonosi műveletek
    if (isOwner) {
        card.querySelector('.rename').onsubmit = async (event) => {
            event.preventDefault();
            const name = event.target.name.value.trim();
            if (!name || name === g.name) return;
            const { error } = await sb.from('groups').update({ name }).eq('id', g.id);
            if (error) return fail(error);
            toast(`✏️ Átnevezve: ${name}`);
            loadHome();
        };
        act('delete').onclick = async () => {
            if (!confirm(`Biztosan törlöd a(z) „${g.name}” csoportot? Ez nem vonható vissza.`)) return;
            const { error } = await sb.rpc('delete_group', { p_group_id: g.id });
            if (error) return fail(error);
            toast(`🗑️ Csoport törölve: ${g.name}`);
            loadHome();
        };
        if (isClass) act('joincode').onclick = async () => {
            const { data, error } = await sb.rpc('create_group_join_code', { p_group_id: g.id });
            if (error) return fail(error);
            const box = card.querySelector('.join-box');
            box.querySelector('.code').innerText = data.code;
            box.querySelector('p').innerText = `Érvényes eddig: ${new Date(data.expires_at).toLocaleDateString('hu-HU',
                { month: 'long', day: 'numeric' })}.`;
            box.hidden = false;
            act('sharejoin').onclick = () => shareText('Szorzótábla Mester – csatlakozás',
                `Csatlakozás a(z) „${g.name}” csoporthoz a Szorzótábla Mesterben: a szülői felületen (${CONSOLE_URL}) ` +
                `a gyereked oldalán add meg ezt a kódot: ${data.code}`, null);
        };
    }
    card.querySelectorAll('.role-select').forEach(select => {
        select.onchange = async () => {
            const { error } = await sb.rpc('set_member_role',
                { p_group_id: g.id, p_adult_id: select.dataset.member, p_role: select.value });
            if (error) fail(error);
            else toast('✅ Szerep módosítva');
            loadHome();
        };
    });
    card.querySelectorAll('[data-remove]').forEach(btn => {
        btn.onclick = async () => {
            const self = btn.dataset.remove === me.id;
            if (!confirm(self ? `Biztosan kilépsz a(z) „${g.name}” csoportból?` : 'Biztosan eltávolítod őt a csoportból?')) return;
            const { error } = await sb.rpc('remove_member', { p_group_id: g.id, p_adult_id: btn.dataset.remove });
            if (error) return fail(error);
            toast(self ? `👋 Kiléptél: ${g.name}` : '✅ Eltávolítva a csoportból');
            loadHome();
        };
    });
    return card;
}

// Egy felnőtt sora a csoportban: a tulajdonos módosíthatja a szerepét / eltávolíthatja; magából kiléphet
function memberRow(m, isOwner) {
    const self = m.adult_id === me.id;
    let actions = `<span class="muted">${m.role === 'owner' ? 'tulajdonos' : 'tag'}</span>`;
    if (isOwner && !self) {
        actions = `
            <select class="role-select" data-member="${m.adult_id}" aria-label="Szerep">
                <option value="member" ${m.role === 'member' ? 'selected' : ''}>tag</option>
                <option value="owner" ${m.role === 'owner' ? 'selected' : ''}>tulajdonos</option>
            </select>
            <button class="link" data-remove="${m.adult_id}">eltávolítás</button>`;
    } else if (self) {
        actions += ` <button class="link" data-remove="${m.adult_id}">kilépés</button>`;
    }
    return `<li><span>${esc(m.adults ? m.adults.email : '?')}${self ? ' (te)' : ''}</span><span class="row">${actions}</span></li>`;
}

// Megosztás: telefonon a rendszer megosztó menüje, máshol vágólap
async function shareText(title, text, url) {
    if (navigator.share) {
        try {
            await navigator.share(url ? { title, text, url } : { title, text });
        } catch (e) { /* bezárta a megosztó menüt */ }
        return;
    }
    try {
        await navigator.clipboard.writeText(url ? `${text} ${url}` : text);
        toast('📋 A vágólapra került');
    } catch (e) {
        toast(url || text);
    }
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
    await sendInviteMail(email, msgEl);
}

// A meghívott belépő linket kap e-mailben (a meghívó már az adatbázisban van, ettől regisztrálhat)
async function sendInviteMail(email, msgEl) {
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

// Az admin szerepet választva hív meg: szülő (család) és / vagy tanár (osztály)
async function inviteCreator(event) {
    event.preventDefault();
    const msgEl = document.getElementById('creator-msg');
    const email = document.getElementById('creator-email').value.trim().toLowerCase();
    const families = document.getElementById('creator-family').checked;
    const classes = document.getElementById('creator-class').checked;
    if (!families && !classes) return setMsg(msgEl, 'error', 'Válaszd ki, szülőként vagy tanárként hívod-e meg.');
    setMsg(msgEl, '', 'Meghívás…');
    const { data: result, error } = await sb.rpc('admin_invite', { p_email: email, p_families: families, p_classes: classes });
    if (error) return setMsg(msgEl, 'error', error.message);
    if (result === 'added') {
        setMsg(msgEl, 'ok', `${email} már regisztrált: megkapta a szerepet.`);
        return loadAdmin();
    }
    await sendInviteMail(email, msgEl);
}

const rightsText = (families, classes) =>
    [families && '🏠 Szülő', classes && '🏫 Tanár'].filter(Boolean).join(' · ');

async function loadPending() {
    const { data, error } = await sb.from('invitations')
        .select('id, email, created_at, can_create_groups, can_create_classes, groups ( name )')
        .is('accepted_at', null).order('created_at', { ascending: false });
    if (error) return fail(error);
    document.getElementById('pending-sub').innerText = data.length
        ? `${data.length} még nem lépett be` : 'nincs függő meghívó';
    const list = document.getElementById('pending-list');
    list.innerHTML = data.map(inv => `
        <li><span>${esc(inv.email)} <span class="muted">${inv.groups ? '→ ' + esc(inv.groups.name)
            : esc(rightsText(inv.can_create_groups, inv.can_create_classes))} · ${esc(whenText(inv.created_at))}</span></span>
            <button class="link" data-id="${inv.id}">visszavonás</button></li>`).join('')
        || '<li class="muted">Minden meghívott belépett már.</li>';
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
    // minden gyerek oldala zárt részekkel indul (ne maradjon nyitva az előző gyereknél lenyitott rész)
    document.querySelectorAll('#view-child details').forEach(d => { d.open = false; });
    renderChildHead();
    setMsg('join-msg', '', '');
    document.getElementById('join-code').value = '';
    document.getElementById('delete-child-btn').hidden = !currentChild.owner;
    document.getElementById('code-box').hidden = true;
    try {
        await Promise.all([loadChildStats(), loadDevices(), loadChildGroups(), loadChildAssignments(), loadChildStars()]);
    } catch (e) {
        return fail(e);
    }
    applyChildRights();
    placeAssignForm('child');
    show('view-child');
    renderChildStats(); // a grafikonnak látható vászon kell
}

// "A család az első": ha a gyereknek van családja, az eszközeit, PIN-jét, nevét és a törlést a család kezeli
// (a tanár látja az eredményeket, de ezeket nem). Ugyanezt az adatbázis is kikényszeríti.
function applyChildRights() {
    const groupsOfChild = currentChild.groups || [];
    const hasFamily = groupsOfChild.some(g => g.kind === 'family');
    const primary = hasFamily ? groupsOfChild.some(g => g.kind === 'family' && g.is_member) : true;
    const primaryOwner = hasFamily ? groupsOfChild.some(g => g.kind === 'family' && g.is_owner) : currentChild.owner;
    ['child-edit-box', 'child-join-box', 'child-devices-card', 'child-pin-card', 'clear-stats-btn']
        .forEach(id => { document.getElementById(id).hidden = !primary; });
    document.getElementById('delete-child-btn').hidden = !primaryOwner;
    document.getElementById('child-danger-card').hidden = !primary && !primaryOwner;
}

const groupLabel = g => `${g.kind === 'class' ? '🏫' : '🏠'} ${g.name || 'egy másik család'}`;

async function loadChildAssignments() {
    const { data, error } = await sb.rpc('child_assignments', { p_child_id: currentChild.id });
    if (error) throw error;
    const list = document.getElementById('child-assignments');
    list.innerHTML = data.map(a => {
        const overdue = a.due_date && new Date(`${a.due_date}T23:59:59`) < new Date();
        const due = a.due_date ? ` · határidő: ${new Date(`${a.due_date}T12:00:00`).toLocaleDateString('hu-HU', { month: 'short', day: 'numeric' })}` : '';
        const where = a.group_name ? `${a.group_kind === 'class' ? '🏫' : '🏠'} ${esc(a.group_name)}` : '🏠 család';
        const status = a.done ? `✅ kész (${a.last_pct}%)` : overdue ? '⚠️ lejárt' : '⏳ még nincs kész';
        return `<li><span>📌 ${esc(assignmentLabel(a))}<br><span class="muted">${a.for_child ? '👤 csak neki · ' : ''}${where}${esc(due)}${a.note ? ` · 💬 ${esc(a.note)}` : ''}</span></span>
            <span>${status}${a.can_delete ? `<br><button class="link danger-link" data-del-assignment="${a.id}">törlés</button>` : ''}</span></li>`;
    }).join('') || '<li class="muted">Még nincs kiosztott feladat.</li>';
    list.querySelectorAll('[data-del-assignment]').forEach(btn => {
        btn.onclick = async () => {
            if (!confirm('Törlöd ezt a feladatot? Az eddigi eredmények és csillagok megmaradnak.')) return;
            const { error: delError } = await sb.from('assignments').delete().eq('id', btn.dataset.delAssignment);
            if (delError) return fail(delError);
            loadChildAssignments().catch(fail);
        };
    });
}

/* ---------- Csillagok és célok (a szülő és a tanár is ad csillagot, tűz ki célt) ---------- */

const GOAL_EMOJIS = ['🎁', '🍦', '🎬', '🎮', '⚽', '🧸', '📚', '🍕', '🏊', '🎨', '🎢', '🐶'];
let goalEmoji = GOAL_EMOJIS[0];
const starFromText = from => (from ? `${from.kind === 'class' ? '🏫' : '🏠'} ${from.name || (from.kind === 'class' ? 'osztály' : 'egy másik család')}` : '');

async function loadChildStars() {
    const { data, error } = await sb.rpc('child_stars', { p_child_id: currentChild.id });
    if (error) throw error;
    document.getElementById('child-stars-total').innerText = data.total;
    document.getElementById('child-stars-sub').innerText = `csillaga van (gyakorlásért ${data.total - data.granted}, ajándék ${data.granted})`;
    document.getElementById('star-rules').innerText = STAR_RULES;

    const goals = document.getElementById('child-goals');
    goals.innerHTML = data.goals.map(g => {
        const reached = g.progress >= g.target;
        const status = g.redeemed_at ? `✅ beváltva ${esc(whenText(g.redeemed_at))}` : reached ? '🎉 elérte!' : `${g.progress} / ${g.target} ⭐`;
        return `<div class="goal-item${g.redeemed_at ? ' redeemed' : ''}">
            <div class="goal-head"><span>${esc(g.emoji)} ${esc(g.title)}</span><span>${status}</span></div>
            ${g.redeemed_at ? '' : `<div class="goal-bar"><i style="width:${Math.round(100 * g.progress / g.target)}%"></i></div>`}
            <div class="row"><span class="muted">${esc(starFromText(g.from))} · kitűzve ${esc(whenText(g.created_at))}</span>
                ${g.can_manage && !g.redeemed_at && reached ? `<button class="btn" data-redeem="${g.id}">✅ Beváltva</button>` : ''}
                ${g.can_manage ? `<button class="link danger-link" data-del-goal="${g.id}">törlés</button>` : ''}</div>
        </div>`;
    }).join('') || '<p class="muted">Még nincs cél. Tűzz ki egyet: a gyerek az appban látja, mennyi csillag hiányzik még.</p>';
    goals.querySelectorAll('[data-redeem]').forEach(btn => {
        btn.onclick = async () => {
            const { error: redeemError } = await sb.rpc('redeem_star_goal', { p_goal_id: btn.dataset.redeem });
            if (redeemError) return fail(redeemError);
            toast('✅ Beváltva – szép munka volt!');
            loadChildStars().catch(fail);
        };
    });
    goals.querySelectorAll('[data-del-goal]').forEach(btn => {
        btn.onclick = async () => {
            if (!confirm('Törlöd ezt a célt? A csillagok megmaradnak.')) return;
            const { error: delError } = await sb.from('star_goals').delete().eq('id', btn.dataset.delGoal);
            if (delError) return fail(delError);
            loadChildStars().catch(fail);
        };
    });

    document.getElementById('grants-sub').innerText = data.grants.length
        ? `legutóbb: +${data.grants[0].amount} ⭐ ${whenText(data.grants[0].created_at)}` : 'még nem kapott';
    const grants = document.getElementById('grant-list');
    grants.innerHTML = data.grants.map(g => `
        <li><span>+${g.amount} ⭐ ${g.note ? `· 💬 ${esc(g.note)}` : ''}<br><span class="muted">${esc(starFromText(g.from))} · ${esc(whenText(g.created_at))}</span></span>
            ${g.can_delete ? `<button class="link" data-del-grant="${g.id}">visszavonás</button>` : ''}</li>`).join('')
        || '<li class="muted">Még nem kapott ajándék csillagot.</li>';
    grants.querySelectorAll('[data-del-grant]').forEach(btn => {
        btn.onclick = async () => {
            const { error: delError } = await sb.from('star_grants').delete().eq('id', btn.dataset.delGrant);
            if (delError) return fail(delError);
            loadChildStars().catch(fail);
        };
    });

    const picks = document.getElementById('goal-emojis');
    picks.innerHTML = GOAL_EMOJIS.map(e => `<button type="button" data-emoji="${e}" class="${e === goalEmoji ? 'selected' : ''}">${e}</button>`).join('');
    picks.querySelectorAll('button').forEach(btn => {
        btn.onclick = () => {
            goalEmoji = btn.dataset.emoji;
            picks.querySelectorAll('button').forEach(b => b.classList.toggle('selected', b === btn));
        };
    });
}

async function createGoal(event) {
    event.preventDefault();
    const title = document.getElementById('goal-title').value.trim();
    const target = Math.max(1, Math.min(1000, +document.getElementById('goal-target').value || 30));
    const { error } = await sb.rpc('create_star_goal', { p_child_id: currentChild.id, p_title: title, p_emoji: goalEmoji, p_target: target });
    if (error) return fail(error);
    document.getElementById('goal-title').value = '';
    toast(`🎯 Cél kitűzve: ${goalEmoji} ${title} – ${target} ⭐`);
    loadChildStars().catch(fail);
}

async function grantStars(event) {
    event.preventDefault();
    const amount = +document.getElementById('grant-amount').value;
    const { error } = await sb.rpc('grant_stars',
        { p_child_id: currentChild.id, p_amount: amount, p_note: document.getElementById('grant-note').value });
    if (error) return fail(error);
    document.getElementById('grant-note').value = '';
    toast(`🎁 ${currentChild.nickname} kapott ${amount} ⭐-ot`);
    loadChildStars().catch(fail);
}

async function grantGroupStars(event) {
    event.preventDefault();
    const amount = +document.getElementById('group-grant-amount').value;
    const { data, error } = await sb.rpc('grant_stars_group',
        { p_group_id: currentGroup.id, p_amount: amount, p_note: document.getElementById('group-grant-note').value });
    if (error) return fail(error);
    document.getElementById('group-grant-note').value = '';
    toast(`🎁 ${data} gyerek kapott ${amount} ⭐-ot`);
    loadGroupChildren().catch(fail);
}

/* ---------- A gyerek neve, avatarja ---------- */

function renderChildHead() {
    document.getElementById('child-avatar').innerText = currentChild.avatar;
    document.getElementById('child-name').innerText = currentChild.nickname;
    document.getElementById('settings-child-name').innerText = currentChild.nickname;
    document.getElementById('edit-nickname').value = currentChild.nickname;
    const box = document.getElementById('edit-avatars');
    box.innerHTML = AVATARS.map(a => `<button type="button" data-avatar="${a}" class="${a === currentChild.avatar ? 'selected' : ''}">${a}</button>`).join('');
    box.querySelectorAll('button').forEach(btn => {
        btn.onclick = () => box.querySelectorAll('button').forEach(b => b.classList.toggle('selected', b === btn));
    });
}

async function saveChild(event) {
    event.preventDefault();
    const nickname = document.getElementById('edit-nickname').value.trim();
    const selected = document.querySelector('#edit-avatars button.selected');
    const avatar = selected ? selected.dataset.avatar : currentChild.avatar;
    const { error } = await sb.from('children').update({ nickname, avatar }).eq('id', currentChild.id);
    if (error) return fail(error);
    Object.assign(currentChild, { nickname, avatar });
    renderChildHead();
    toast(`✅ Mentve: ${avatar} ${nickname}`);
}

/* ---------- A gyerek csoportjai: hozzáadás, áthelyezés, kivétel, osztály-csatlakozás ---------- */

async function loadChildGroups() {
    const { data, error } = await sb.rpc('child_groups_info', { p_child_id: currentChild.id });
    if (error) throw error;
    currentChild.groups = data;
    document.getElementById('child-groups-sub').innerText = data.map(groupLabel).join(', ');
    const list = document.getElementById('child-group-list');
    list.innerHTML = data.map(g => `
        <li><span>${esc(groupLabel(g))}
            <span class="muted">${g.is_owner ? '· tulajdonos vagy' : g.is_member ? '· tag vagy' : ''}</span></span>
            ${g.can_remove && data.length > 1 ? `<button class="link" data-group="${g.group_id}">kivétel</button>` : ''}</li>`).join('');
    list.querySelectorAll('button').forEach(btn => {
        btn.onclick = async () => {
            const g = data.find(x => x.group_id === btn.dataset.group);
            if (!confirm(`Kiveszed ${currentChild.nickname}-t a(z) „${g.name || 'család'}” csoportból? Az eredményei megmaradnak.`)) return;
            const { error: removeError } = await sb.rpc('remove_child_from_group', { p_child_id: currentChild.id, p_group_id: g.group_id });
            if (removeError) return fail(removeError);
            toast('✅ Kivéve a csoportból');
            await refreshAfterGroupChange();
        };
    });

    // Hozzáadni a saját csoportjaimhoz lehet, amelyikben még nincs benne
    const inIds = new Set(data.map(g => g.group_id));
    const targets = groups.filter(g => !inIds.has(g.id));
    const select = document.getElementById('child-target-group');
    select.innerHTML = targets.map(g => `<option value="${g.id}">${g.kind === 'class' ? '🏫' : '🏠'} ${esc(g.name)}</option>`).join('');
    document.getElementById('child-add-group').hidden = !targets.length;
    // Áthelyezés: ha pontosan egy olyan csoportban van, amelyből kivehetem
    const movable = data.filter(g => g.can_remove);
    document.getElementById('child-move-btn').hidden = !(movable.length === 1 && data.length >= 1);
}

async function refreshAfterGroupChange() {
    await loadHome();
    const stillVisible = groups.some(g => g.child_groups.some(cg => cg.children && cg.children.id === currentChild.id));
    if (stillVisible) await openChild(currentChild.id);
}

async function addChildToGroup(event) {
    event.preventDefault();
    const groupId = document.getElementById('child-target-group').value;
    const { error } = await sb.from('child_groups').insert({ child_id: currentChild.id, group_id: groupId });
    if (error) return fail(error);
    toast(`✅ ${currentChild.nickname} hozzáadva a csoporthoz`);
    await refreshAfterGroupChange();
}

// Áthelyezés: hozzáadás az új csoporthoz, majd kivétel abból az egyből, ahonnan kivehetem
async function moveChildToGroup() {
    const target = document.getElementById('child-target-group').value;
    const source = currentChild.groups.find(g => g.can_remove);
    if (!target || !source) return;
    const { error } = await sb.from('child_groups').insert({ child_id: currentChild.id, group_id: target });
    if (error) return fail(error);
    const { error: removeError } = await sb.rpc('remove_child_from_group', { p_child_id: currentChild.id, p_group_id: source.group_id });
    if (removeError) return fail(removeError);
    toast(`➡️ ${currentChild.nickname} áthelyezve`);
    await refreshAfterGroupChange();
}

async function joinClass(event) {
    event.preventDefault();
    const code = document.getElementById('join-code').value.trim().toUpperCase();
    if (!/^[A-Z2-9]{6}$/.test(code)) return setMsg('join-msg', 'error', 'A kód 6 karakter (betűk és számok).');
    const { data, error } = await sb.rpc('join_group_with_code', { p_child_id: currentChild.id, p_code: code });
    if (error) return setMsg('join-msg', 'error', error.message);
    if (data.error) return setMsg('join-msg', 'error', data.error);
    toast(`🏫 ${currentChild.nickname} bekerült: ${data.name}`);
    await refreshAfterGroupChange();
}

/* ---------- Admin: felnőttek kezelése ---------- */

async function loadAdmin() {
    const { data, error } = await sb.rpc('admin_adults');
    if (error) return fail(error);
    const list = document.getElementById('admin-adults');
    document.getElementById('admin-count').innerText = data.length;
    list.innerHTML = data.map(a => {
        const self = a.id === me.id;
        const groupsText = a.groups.map(g => `${g.kind === 'class' ? '🏫' : '🏠'} ${esc(g.name)}${g.role === 'owner' ? ' (tulajdonos)' : ''}`).join(', ') || 'nincs csoportja';
        const roles = [a.is_admin && '🛡️ Admin', rightsText(a.can_create_groups, a.can_create_classes)].filter(Boolean).join(' · ');
        return settingItem(a.is_admin ? '🛡️' : '👤', `${esc(a.email)}${self ? ' (te)' : ''}`,
            `${roles || 'meghívott családtag / tanártárs'} · belépett: ${esc(whenText(a.last_sign_in_at))}`, `
            <p class="muted">Csoportjai: ${groupsText}</p>
            <label class="toggle-row"><input type="checkbox" data-rights="${a.id}" data-kind="family" ${a.can_create_groups ? 'checked' : ''}>
                🏠 Szülő – családot hozhat létre</label>
            <label class="toggle-row"><input type="checkbox" data-rights="${a.id}" data-kind="class" ${a.can_create_classes ? 'checked' : ''}>
                🏫 Tanár – osztályt hozhat létre</label>
            ${self ? '' : `
            <p class="muted">A hozzáférés megvonása törli a fiókot; ahol egyedül volt, a csoportját és a csak abban lévő gyerekeket is.</p>
            <div class="row"><button class="btn danger" data-revoke="${a.id}" data-email="${esc(a.email)}">🚫 Hozzáférés megvonása</button></div>`}`);
    }).join('');
    list.querySelectorAll('[data-rights]').forEach(box => {
        box.onchange = async () => {
            const id = box.dataset.rights;
            const value = kind => list.querySelector(`[data-rights="${id}"][data-kind="${kind}"]`).checked;
            const { error: setError } = await sb.rpc('admin_set_rights', { p_adult: id, p_families: value('family'), p_classes: value('class') });
            if (setError) return fail(setError);
            toast('✅ Mentve');
            if (id === me.id) loadHome(); // a saját szerepem: a fülek és a fejléc is változik
        };
    });
    list.querySelectorAll('[data-revoke]').forEach(btn => {
        btn.onclick = async () => {
            if (!confirm(`Biztosan megvonod ${btn.dataset.email} hozzáférését? A fiókja törlődik; ahol egyedül volt, ` +
                'a csoportja és a csak abban lévő gyerekek eredményei is. Ez nem vonható vissza.')) return;
            const { error: revokeError } = await sb.rpc('admin_remove_adult', { p_adult: btn.dataset.revoke });
            if (revokeError) return fail(revokeError);
            toast(`🚫 Hozzáférés megvonva: ${btn.dataset.email}`);
            loadHome();
        };
    });
}

/* ---------- Saját fiók törlése ---------- */

async function deleteMyAccount() {
    const typed = prompt(`A fiókod végleges törléséhez írd be az e-mail címed (${me.email}):`);
    if (typed === null) return;
    if (typed.trim().toLowerCase() !== me.email) return toast('Nem egyezik az e-mail cím, nem töröltünk semmit.');
    const { error } = await sb.rpc('delete_my_account');
    if (error) return fail(error);
    await sb.auth.signOut();
    me = null;
    document.getElementById('who').hidden = true;
    show('view-login');
    setMsg('login-msg', 'ok', 'A fiókodat töröltük. Köszönjük, hogy használtad a Szorzótábla Mestert!');
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
    const last = data.map(d => d.last_seen).filter(Boolean).sort().pop();
    document.getElementById('device-sub').innerText = data.length
        ? `${data.length} összekötött eszköz · utoljára ${whenText(last)}` : 'nincs összekötött eszköz – kóddal köthető össze';
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
    document.getElementById('pin-sub').innerText = currentChild.hasPin ? '🔒 be van kapcsolva' : 'nincs beállítva (nem kötelező)';
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
    if (!confirm(`Biztosan törlöd ${currentChild.nickname} összes eredményét (a gyakorlásért kapott csillagokat is)? Ez nem vonható vissza.`)) return;
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

/* ---------- Egy csoport együtt: összesített térkép, gyerekek, kiosztott feladatok ---------- */

let currentGroup = null;
let groupFacts = {};
let groupHeatmapOp = 'mul';
const TABLE_SUFFIX = ['s', 'es', 'es', 'as', 'es', 'ös', 'os', 'es', 'as', 'es', 'es'];
const OP_NAMES = { mul: 'szorzás', div: 'osztás', mix: 'vegyes' };

async function openGroup(id) {
    const g = groups.find(x => x.id === id);
    currentGroup = { ...g, isOwner: g.group_members.some(m => m.adult_id === me.id && m.role === 'owner') };
    show('loading');
    document.getElementById('group-icon').innerText = g.kind === 'class' ? '🏫' : '🏠';
    document.getElementById('group-title').innerText = g.name;
    renderAssignTables();
    placeAssignForm('group');
    try {
        await Promise.all([loadGroupFacts(), loadGroupChildren(), loadAssignments()]);
    } catch (e) {
        return fail(e);
    }
    show('view-group');
    renderHeatmapGrid(document.getElementById('group-heatmap'), document.getElementById('group-hm-detail'),
        groupFacts, groupHeatmapOp, GROUP_HEATMAP);
}

async function loadGroupFacts() {
    const { data, error } = await sb.rpc('group_facts', { p_group_id: currentGroup.id });
    if (error) throw error;
    groupFacts = groupFactsMap(data);
}

function setGroupHeatmapOp(op, btn) {
    groupHeatmapOp = op;
    btn.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('selected', b === btn));
    renderHeatmapGrid(document.getElementById('group-heatmap'), document.getElementById('group-hm-detail'),
        groupFacts, op, GROUP_HEATMAP);
}

async function loadGroupChildren() {
    const { data, error } = await sb.rpc('group_children_summary', { p_group_id: currentGroup.id });
    if (error) throw error;
    const list = document.getElementById('group-children');
    list.innerHTML = data.map(c => `
        <li class="clickable" data-child="${c.child_id}">
            <span><strong>${esc(c.avatar)} ${esc(c.nickname)}</strong><br>
                <span class="muted">az elmúlt 7 napban ${c.answers_7d} feladat · összesen ${c.answers_total} ·
                    utoljára ${esc(c.last_answer ? whenText(c.last_answer) : 'még nem gyakorolt')}</span></span>
            <span>⭐ ${c.stars ?? 0}<br>${c.weak ? `🎯 ${c.weak} gyakorlásra vár` : (c.answers_total ? '🎉 nincs hibás' : '')}</span>
        </li>`).join('') || '<li class="muted">Még nincs gyerek a csoportban.</li>';
    list.querySelectorAll('[data-child]').forEach(li => { li.onclick = () => openChild(li.dataset.child); });
}

// Az egyetlen feladat-űrlap oda kerül, ahol éppen kiosztanak: a csoport nézetbe vagy a gyerek oldalára
let assignTarget = null; // { groupId } vagy { childId }
function placeAssignForm(where) {
    const box = document.getElementById('assign-box');
    box.open = false;
    document.getElementById(where === 'child' ? 'child-assign-slot' : 'group-assign-slot').appendChild(box);
    assignTarget = where === 'child' ? { childId: currentChild.id } : { groupId: currentGroup.id };
    document.getElementById('assign-sub').innerText = where === 'child'
        ? `csak ${currentChild.nickname} kapja meg` : 'a csoport minden gyereke megkapja';
    renderAssignTables();
}

function renderAssignTables() {
    const box = document.getElementById('assign-tables');
    box.innerHTML = Array.from({ length: 11 }, (_, t) => `<button type="button" data-table="${t}">${t}-${TABLE_SUFFIX[t]}</button>`).join('');
    box.querySelectorAll('button').forEach(btn => { btn.onclick = () => btn.classList.toggle('selected'); });
}

// Egy feladat rövid leírása: "7-es, 8-as tábla · osztás · 20 db"
function assignmentLabel(a) {
    const tables = a.tables.map(t => `${t}-${TABLE_SUFFIX[t]}`).join(', ');
    const amount = a.mode === 'exam' ? 'kikérdező, az összes' : (a.question_count ? `gyakorló, ${a.question_count} db` : 'gyakorló, az összes');
    return `${tables} tábla · ${OP_NAMES[a.op]} · ${amount}`;
}

async function createAssignment(event) {
    event.preventDefault();
    const tables = [...document.querySelectorAll('#assign-tables button.selected')].map(b => +b.dataset.table);
    if (!tables.length) return toast('Válassz legalább egy táblát!');
    const mode = document.getElementById('assign-mode').value;
    const { error } = await sb.rpc('create_assignment', {
        p_group_id: assignTarget.groupId || null,
        p_child_id: assignTarget.childId || null,
        p_op: document.getElementById('assign-op').value,
        p_tables: tables,
        p_mode: mode,
        p_count: mode === 'exam' ? null : Math.max(1, Math.min(242, +document.getElementById('assign-count').value || 20)),
        p_due: document.getElementById('assign-due').value || null,
        p_note: document.getElementById('assign-note').value,
    });
    if (error) return fail(error);
    toast(assignTarget.childId ? `📌 Feladat kiosztva ${currentChild.nickname} számára` : '📌 Feladat kiosztva');
    document.getElementById('assign-note').value = '';
    renderAssignTables();
    (assignTarget.childId ? loadChildAssignments() : loadAssignments()).catch(fail);
}

async function loadAssignments() {
    const [tasksRes, progressRes] = await Promise.all([
        sb.from('assignments').select('id, child_id, op, tables, mode, question_count, due_date, note, created_by, created_at')
            .eq('group_id', currentGroup.id).order('created_at', { ascending: false }),
        sb.rpc('assignment_progress', { p_group_id: currentGroup.id }),
    ]);
    if (tasksRes.error) throw tasksRes.error;
    if (progressRes.error) throw progressRes.error;
    const list = document.getElementById('assignment-list');
    if (!tasksRes.data.length) {
        list.innerHTML = '<p class="muted">Még nincs kiosztott feladat.</p>';
        return;
    }
    list.innerHTML = tasksRes.data.map(a => {
        const rows = progressRes.data.filter(p => p.assignment_id === a.id).sort((x, y) => x.nickname.localeCompare(y.nickname, 'hu'));
        const done = rows.filter(p => p.done > 0).length;
        const overdue = a.due_date && new Date(`${a.due_date}T23:59:59`) < new Date();
        const canDelete = a.created_by === me.id || currentGroup.isOwner;
        return `
        <div class="assignment">
            <div><strong>📌 ${esc(assignmentLabel(a))}</strong>${a.child_id && rows[0] ? ` <span class="badge">👤 csak ${esc(rows[0].nickname)}</span>` : ''}
                <span class="muted">${a.due_date ? ` · határidő: ${esc(new Date(`${a.due_date}T12:00:00`).toLocaleDateString('hu-HU', { month: 'short', day: 'numeric', weekday: 'short' }))}${overdue ? ' (lejárt)' : ''}` : ''}
                · kész: ${done}/${rows.length}</span></div>
            ${a.note ? `<div class="muted">💬 ${esc(a.note)}</div>` : ''}
            <div class="progress">${rows.map(p => p.done
                ? `<span class="done">${esc(p.avatar)} ${esc(p.nickname)} ✅ ${p.last_pct}%${p.done > 1 ? ` (${p.done}×, legjobb ${p.best_pct}%)` : ''}</span>`
                : `<span>${esc(p.avatar)} ${esc(p.nickname)} ${overdue ? '⚠️' : '⏳'}</span>`).join('')}</div>
            ${canDelete ? `<div><button class="link danger-link" data-del-assignment="${a.id}">feladat törlése</button></div>` : ''}
        </div>`;
    }).join('');
    list.querySelectorAll('[data-del-assignment]').forEach(btn => {
        btn.onclick = async () => {
            if (!confirm('Törlöd ezt a feladatot? A gyerekek eddigi eredményei megmaradnak.')) return;
            const { error } = await sb.from('assignments').delete().eq('id', btn.dataset.delAssignment);
            if (error) return fail(error);
            loadAssignments().catch(fail);
        };
    });
}

init().catch(fail);
