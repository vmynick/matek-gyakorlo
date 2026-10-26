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
    if (me.is_admin) loadAdmin();
}

function groupCard(g) {
    const isOwner = g.group_members.some(m => m.adult_id === me.id && m.role === 'owner');
    const children = g.child_groups.map(cg => cg.children).filter(Boolean)
        .sort((a, b) => a.nickname.localeCompare(b.nickname, 'hu'));
    const card = document.createElement('section');
    card.className = 'card';
    card.innerHTML = `
        <h2>${g.kind === 'class' ? '🏫' : '🏠'} ${esc(g.name)} <span class="muted">${isOwner ? 'tulajdonos' : 'tag'}</span></h2>
        ${isOwner ? `
        <div class="row group-actions">
            <button class="link" data-act="rename">✏️ Átnevezés</button>
            <button class="link" data-act="joincode">🔑 Csatlakozási kód szülőknek</button>
            <button class="link danger-link" data-act="delete">🗑️ Csoport törlése</button>
        </div>
        <div class="code-box join-box" hidden>
            <div class="code"></div>
            <p class="muted"></p>
            <div class="row" style="justify-content:center">
                <button class="btn secondary" data-act="sharejoin">📤 Kód küldése a szülőknek</button>
            </div>
        </div>` : ''}
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
            <ul class="members">${g.group_members.map(m => memberRow(m, isOwner)).join('')}</ul>
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

    // Tulajdonosi műveletek
    const act = name => card.querySelector(`[data-act="${name}"]`);
    if (isOwner) {
        act('rename').onclick = async () => {
            const name = (prompt('A csoport új neve:', g.name) || '').trim();
            if (!name || name === g.name) return;
            const { error } = await sb.from('groups').update({ name }).eq('id', g.id);
            if (error) return fail(error);
            toast(`✏️ Átnevezve: ${name}`);
            loadHome();
        };
        act('delete').onclick = async () => {
            if (!confirm(`Biztosan törlöd a(z) „${g.name}” csoportot? Azok a gyerekek, akik csak ebben a csoportban vannak, ` +
                'minden eredményükkel együtt törlődnek. Ez nem vonható vissza.')) return;
            const { error } = await sb.rpc('delete_group', { p_group_id: g.id });
            if (error) return fail(error);
            toast(`🗑️ Csoport törölve: ${g.name}`);
            loadHome();
        };
        act('joincode').onclick = async () => {
            const { data, error } = await sb.rpc('create_group_join_code', { p_group_id: g.id });
            if (error) return fail(error);
            const box = card.querySelector('.join-box');
            box.querySelector('.code').innerText = data.code;
            box.querySelector('p').innerText = `Érvényes eddig: ${new Date(data.expires_at).toLocaleDateString('hu-HU',
                { month: 'long', day: 'numeric' })}. A szülő a gyereke oldalán, a „Csatlakozás osztályhoz kóddal” résznél írja be. ` +
                'Bárhány szülő használhatja; új kód kérésekor a régi érvényét veszti.';
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
    renderChildHead();
    setMsg('join-msg', '', '');
    document.getElementById('join-code').value = '';
    document.getElementById('delete-child-btn').hidden = !currentChild.owner;
    document.getElementById('code-box').hidden = true;
    try {
        await Promise.all([loadChildStats(), loadDevices(), loadChildGroups()]);
    } catch (e) {
        return fail(e);
    }
    show('view-child');
    renderChildStats(); // a grafikonnak látható vászon kell
}

/* ---------- A gyerek neve, avatarja ---------- */

function renderChildHead() {
    document.getElementById('child-avatar').innerText = currentChild.avatar;
    document.getElementById('child-name').innerText = currentChild.nickname;
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
    const list = document.getElementById('child-group-list');
    list.innerHTML = data.map(g => `
        <li><span>${g.kind === 'class' ? '🏫' : '🏠'} ${esc(g.name || 'egy másik család')}
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
    list.innerHTML = data.map(a => {
        const self = a.id === me.id;
        const groupsText = a.groups.map(g => `${g.kind === 'class' ? '🏫' : '🏠'} ${esc(g.name)}${g.role === 'owner' ? ' (tulajdonos)' : ''}`).join(', ') || 'nincs csoportja';
        return `
        <li>
            <span><strong>${esc(a.email)}</strong>${self ? ' (te)' : ''}${a.is_admin ? ' 🛡️' : ''}<br>
                <span class="muted">${groupsText} · utoljára belépett: ${esc(whenText(a.last_sign_in_at))}</span></span>
            <span class="row">
                <label class="muted"><input type="checkbox" data-create="${a.id}" ${a.can_create_groups ? 'checked' : ''} ${self ? 'disabled' : ''}> csoportot hozhat létre</label>
                ${self ? '' : `<button class="link danger-link" data-revoke="${a.id}" data-email="${esc(a.email)}">hozzáférés megvonása</button>`}
            </span>
        </li>`;
    }).join('');
    list.querySelectorAll('[data-create]').forEach(box => {
        box.onchange = async () => {
            const { error: setError } = await sb.rpc('admin_set_can_create_groups', { p_adult: box.dataset.create, p_value: box.checked });
            if (setError) return fail(setError);
            toast('✅ Mentve');
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
