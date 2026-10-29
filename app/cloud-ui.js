/* Szorzótábla Mester – a felhő a gyerek appjában: eszköz összekötése, „Ki gyakorol most?”, kiosztott feladatok,
   csillagok és célok, a felnőtt eszközén a szülői mód. A szinkron maga a cloud.js-ben van. */

/* --- FELHŐ: AZ ESZKÖZ ÖSSZEKÖTÉSE A GYEREKKEL (cloud.js) --- */
function updateCloudUI() {
    const child = linkedChild();
    const several = linkedChildren().length > 1;
    const chip = document.getElementById('child-chip');
    chip.hidden = !child;
    if (child) chip.innerText = `${child.avatar} ${child.nickname}${several ? ' ⇄' : ''}`;
    chip.title = several ? 'Gyerek váltása' : 'Felhő';
    document.getElementById('parent-mode-btn').hidden = linkedChildren().length > 0; // gyerek eszközén nem kell
    document.getElementById('cloud-footer-btn').innerText = child ? '☁️ Felhő' : '☁️ Eszköz összekötése';
}

/* --- SZÜLŐI MÓD: a felnőtt saját eszközén az app a szülői / tanári felülettel indul --- */
// Az átirányítás a szorzotabla.html elején van; kikapcsolni a szülői felület tetején lévő 🎮 gombbal lehet
function enterParentMode() {
    playSound('click');
    if (!confirm('Szülői mód: ezen az eszközön az app ezentúl a szülői / tanári felülettel indul. ' +
        'A gyakorláshoz a felület tetején lévő „🎮 Gyakorló mód” gombbal válthatsz vissza. Bekapcsolod?')) return;
    try { localStorage.setItem('szorzo_device_mode', 'parent'); } catch (e) { /* tároló nélkül csak most megy át */ }
    location.href = 'szulo.html';
}

// A jelvény: közös tableten gyerekváltás, egyébként a felhő ablak
function onChildChipClick() {
    if (linkedChildren().length > 1) openProfileChooser();
    else openCloudPanel();
}

// code: a szülőtől kapott linkből érkező kód (ilyenkor egy további gyerek összekötése jön)
function openCloudPanel(code) {
    playSound('click');
    const children = linkedChildren();
    const adding = !children.length || typeof code === 'string';
    document.getElementById('cloud-title').innerText = children.length ? '☁️ Felhő' : '☁️ Eszköz összekötése';
    document.getElementById('cloud-linked').hidden = !children.length;
    document.getElementById('cloud-unlinked').hidden = !adding;
    document.getElementById('cloud-add-btn').hidden = adding;
    document.getElementById('cloud-error').innerText = '';
    document.getElementById('cloud-code').value = typeof code === 'string' ? code : '';
    const history = JSON.parse(localStorage.getItem('szorzo_history') || '[]');
    // az eddigi helyi eredmények átvétele csak az első összekötésnél kérdés
    document.getElementById('cloud-import-row').hidden =
        children.length > 0 || (!Object.keys(loadFacts()).length && !history.length);
    if (children.length) {
        renderCloudChildren();
        showCloudStatus();
    }
    document.getElementById('cloud-overlay').hidden = false;
}

function showAddChild() {
    document.getElementById('cloud-unlinked').hidden = false;
    document.getElementById('cloud-add-btn').hidden = true;
    document.getElementById('cloud-code').focus();
}

function renderCloudChildren() {
    const list = document.getElementById('cloud-children');
    list.innerHTML = '';
    linkedChildren().forEach(child => {
        const li = document.createElement('li');
        const name = document.createElement('span');
        name.textContent = `${child.avatar} ${child.nickname}${child.pin_hash ? ' 🔒' : ''}`;
        const unlink = document.createElement('button');
        unlink.className = 'link-btn';
        unlink.textContent = 'leválasztás';
        unlink.onclick = () => unlinkChild(child);
        li.append(name, unlink);
        list.appendChild(li);
    });
}

/* Közös tablet: ki gyakorol most? (induláskor és a jelvényre koppintva) */
function openProfileChooser() {
    const children = linkedChildren();
    if (children.length < 2) return;
    const active = linkedChild();
    const grid = document.getElementById('profile-grid');
    grid.innerHTML = '';
    children.forEach(child => {
        const btn = document.createElement('button');
        btn.className = `profile-btn${active && active.id === child.id ? ' active' : ''}`;
        const avatar = document.createElement('span');
        avatar.className = 'avatar';
        avatar.textContent = child.avatar;
        const name = document.createElement('span');
        name.textContent = `${child.nickname}${child.pin_hash ? ' 🔒' : ''}`;
        btn.append(avatar, name);
        btn.onclick = () => chooseProfile(child);
        grid.appendChild(btn);
    });
    document.getElementById('profile-overlay').hidden = false;
}

function chooseProfile(chosen) {
    playSound('click');
    // a legfrissebb adat kell: a szülő épp most kapcsolhatta be a PIN-t (a szinkron frissíti)
    const child = linkedChildren().find(c => c.id === chosen.id) || chosen;
    const overlay = document.getElementById('profile-overlay');
    const done = () => {
        overlay.hidden = true;
        selectChild(child.id);
        sessionStorage.setItem('szorzo_session_child', child.id);
        onCloudSynced();
        cloudSync();
        showToast(`👋 Szia, ${child.nickname}!`);
    };
    if (!child.pin_hash) return done();
    overlay.hidden = true;
    requireChildPin(child, done, () => { overlay.hidden = false; });
}

// Induláskor: ha több gyerek használja az eszközt és ebben a munkamenetben még nem választottak
function askWhoIsPracticing() {
    if (linkedChildren().length > 1 && !sessionStorage.getItem('szorzo_session_child')) openProfileChooser();
}

function closeCloudPanel() {
    document.getElementById('cloud-overlay').hidden = true;
}

function showCloudStatus() {
    const box = cloudOutbox();
    const waiting = box.answers.length + box.sessions.length;
    const last = localStorage.getItem('szorzo_last_sync');
    const lastText = last
        ? new Date(last).toLocaleString('hu-HU', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : 'még nem volt';
    document.getElementById('cloud-status').innerText =
        (waiting ? `${waiting} eredmény vár feltöltésre${navigator.onLine ? '' : ' (nincs internet)'}. ` : 'Minden eredmény fent van. ') +
        `Utolsó szinkron: ${lastText}.`;
}

async function linkDevice() {
    const code = document.getElementById('cloud-code').value.trim().toUpperCase();
    const errorEl = document.getElementById('cloud-error');
    if (!/^[A-Z2-9]{6}$/.test(code)) {
        errorEl.innerText = 'A kód 6 karakter (betűk és számok).';
        return;
    }
    const btn = document.getElementById('cloud-link-btn');
    btn.disabled = true;
    btn.innerText = 'Összekötés…';
    errorEl.innerText = '';
    try {
        const child = await cloudLink(code, document.getElementById('cloud-import').checked);
        sessionStorage.setItem('szorzo_session_child', child.id); // most ő gyakorol
        localStorage.removeItem('szorzo_device_mode'); // gyerek eszköze lett: a gyakorló app induljon
        closeCloudPanel();
        onCloudSynced();
        showToast(`☁️ Összekötve: ${child.avatar} ${child.nickname}`);
    } catch (e) {
        errorEl.innerText = e.message;
    } finally {
        btn.disabled = false;
        btn.innerText = 'Összekötés';
    }
}

async function syncFromPanel() {
    playSound('click');
    document.getElementById('cloud-status').innerText = 'Szinkronizálás…';
    const ok = await cloudSync();
    if (!linkedChild()) {
        closeCloudPanel();
        return;
    }
    showCloudStatus();
    if (!ok) showToast(navigator.onLine ? '⚠️ Most nem sikerült, később újra próbálja.' : '📴 Nincs internet, az eredmények megvárják.');
}

// Egy gyerek leválasztása erről az eszközről: szülői PIN-hez kötött (a gyerek ne tudja véletlenül megszüntetni)
function unlinkChild(child) {
    closeCloudPanel();
    requireParentPin(async () => {
        if (!confirm(`Biztosan leválasztod ${child.nickname} profilját erről az eszközről? Az eredményei a felhőben megmaradnak.`)) return;
        await cloudUnlink(child.id);
        onCloudSynced();
        showToast(`☁️ ${child.nickname} leválasztva erről az eszközről`);
    });
}

// Szinkron után: a jelvény, a hibák gyakorlása és (ha látszik) a statisztika frissítése
function onCloudSynced() {
    updateCloudUI();
    updateSetupInfo();
    renderAssignments();
    renderStars();
    checkStarNews();
    if (!document.getElementById('profile-overlay').hidden) {
        if (linkedChildren().length > 1) openProfileChooser(); // friss nevek, PIN-ek
        else document.getElementById('profile-overlay').hidden = true;
    }
    if (document.getElementById('screen-stats').classList.contains('active')) {
        renderChart();
        renderHeatmap();
    }
}

/* --- KIOSZTOTT FELADATOK (a szülőtől / tanártól, összekötött eszközön) --- */
// Hány nap van a határidőig (a határidő napja még belefér); negatív = lejárt
function dueDays(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((new Date(y, m - 1, d) - today) / 86400000);
}

function dueText(dateStr) {
    const days = dueDays(dateStr);
    if (days < 0) return 'lejárt, de még megcsinálhatod';
    if (days === 0) return 'ma';
    if (days === 1) return 'holnap';
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('hu-HU', { month: 'short', day: 'numeric', weekday: 'long' });
}

function renderAssignments() {
    const box = document.getElementById('assignments');
    const list = linkedChild() ? JSON.parse(localStorage.getItem('szorzo_assignments') || '[]') : [];
    const open = list.filter(a => !a.done && (!a.due_date || dueDays(a.due_date) >= -7));
    box.hidden = !open.length;
    box.innerHTML = '';
    open.forEach(a => {
        const card = document.createElement('div');
        card.className = 'assignment-card';
        const text = document.createElement('div');
        text.className = 'text';
        const title = document.createElement('strong');
        title.textContent = `📌 Feladat: ${a.tables.map(t => `${t}-${TABLE_SUFFIX[t]}`).join(', ')} tábla`;
        const details = document.createElement('span');
        details.textContent = `${opsName(a.op)} · ${a.mode === 'exam' ? 'kikérdező, az összes' : (a.question_count ? `${a.question_count} db` : 'az összes')}`;
        text.append(title, details);
        if (a.due_date) {
            const due = document.createElement('span');
            due.className = 'due';
            due.textContent = ` · határidő: ${dueText(a.due_date)}`;
            text.append(due);
        }
        if (a.note) {
            const note = document.createElement('div');
            note.textContent = `💬 ${a.note}`;
            text.append(note);
        }
        const start = document.createElement('button');
        start.textContent = 'Indítás ▶';
        start.onclick = () => startAssignment(a);
        card.append(text, start);
        box.appendChild(card);
    });
}

/* --- CSILLAGOK ÉS CÉLOK --- */
const starFrom = from => (from && from.kind === 'class' ? `a tanárodtól${from.name ? ` (${from.name})` : ''}` : 'a családodtól');
const whoToTell = from => (from && from.kind === 'class' ? 'a tanárodnak' : 'a szüleidnek');

function renderStars() {
    const box = document.getElementById('stars-box');
    const stars = linkedChild() ? JSON.parse(localStorage.getItem('szorzo_stars') || 'null') : null;
    box.hidden = !stars;
    if (!stars) return;
    const goals = stars.goals.filter(g => !g.redeemed_at);
    box.innerHTML = `<div class="stars-total" title="${escHtml(STAR_RULES)}">⭐ <strong>${stars.total}</strong> csillagod van</div>` +
        (goals.map(g => {
            const reached = g.progress >= g.target;
            return `<div class="goal${reached ? ' reached' : ''}">
                <div class="goal-head"><span>${escHtml(g.emoji)} ${escHtml(g.title)}</span>
                    <span>${reached ? '🎉 Elérted!' : `${g.progress} / ${g.target} ⭐`}</span></div>
                <div class="goal-bar"><i style="width:${Math.round(100 * g.progress / g.target)}%"></i></div>
                <small>${reached ? `Szólj ${whoToTell(g.from)}, hogy beválthasd!` : `Még ${g.target - g.progress} ⭐ kell hozzá`}</small>
            </div>`;
        }).join('') || '<small>Gyakorolj, és gyűjts csillagokat! A szüleid vagy a tanárod célt is kitűzhet.</small>');
}

// Új ajándék csillag vagy elért cél: ünneplő ablak (egyszerre egy; teszt közben nem)
let starNews = null;
function checkStarNews() {
    if (starNews || !linkedChild() || document.getElementById('screen-quiz').classList.contains('active')) return;
    if (['profile-overlay', 'pin-overlay', 'cloud-overlay'].some(id => !document.getElementById(id).hidden)) return;
    const stars = JSON.parse(localStorage.getItem('szorzo_stars') || 'null');
    if (!stars || !stars.seen) return;
    const grant = stars.grants.find(g => !stars.seen.includes(g.id));
    const goal = !grant && stars.goals.find(g => !g.redeemed_at && g.progress >= g.target && !stars.celebrated.includes(g.id));
    if (!grant && !goal) return;
    starNews = grant ? { list: 'seen', id: grant.id } : { list: 'celebrated', id: goal.id };
    document.getElementById('star-emoji').innerText = grant ? '🎁' : goal.emoji;
    document.getElementById('star-title').innerText = grant ? `+${grant.amount} ⭐ ajándék!` : `Elérted a célod: ${goal.title}!`;
    document.getElementById('star-msg').innerText = grant
        ? `Csillagot kaptál ${starFrom(grant.from)}${grant.note ? `: „${grant.note}”` : '.'}`
        : `Összegyűlt mind a ${goal.target} csillag. Szólj ${whoToTell(goal.from)}, hogy beválthasd!`;
    document.getElementById('star-overlay').hidden = false;
    playSound('correct');
    if (typeof confetti === 'function') confetti({ particleCount: 120, spread: 80, origin: { y: 0.5 }, zIndex: 2000 });
}

function closeStarNews() {
    const stars = JSON.parse(localStorage.getItem('szorzo_stars') || 'null');
    if (stars && starNews) {
        stars[starNews.list].push(starNews.id);
        localStorage.setItem('szorzo_stars', JSON.stringify(stars));
    }
    starNews = null;
    document.getElementById('star-overlay').hidden = true;
    checkStarNews(); // ha van még
}

// A feladat beállításai (táblák, művelet, mód, darabszám), aztán indul a teszt a feladathoz kötve
function startAssignment(a) {
    selectedTables = [...a.tables];
    renderTableSelector();
    selectOps(parseOps(a.op));
    setMode(a.mode === 'exam' ? 'exam' : 'practice');
    questionCountSetting = a.question_count || 'all';
    document.querySelectorAll('.btn-count').forEach(b => b.classList.remove('selected'));
    const countIndex = [10, 20, 30, 'all'].indexOf(questionCountSetting);
    if (countIndex >= 0) document.querySelectorAll('.btn-count')[countIndex].classList.add('selected');
    startQuiz(a.id);
}

// A szülői felületről küldött link (...?kod=ABC234): a kód beírva vár az összekötő ablakban
function openCloudPanelFromLink() {
    const code = (new URLSearchParams(location.search).get('kod') || '').toUpperCase();
    if (!code) return;
    window.history.replaceState(null, '', location.pathname);
    if (/^[A-Z2-9]{6}$/.test(code)) openCloudPanel(code);
}
