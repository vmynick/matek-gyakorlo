/* Szorzótábla Mester – offline működés és frissítés (service worker), verziószám, link megosztása, üzenetsáv. */

/* --- OFFLINE MŰKÖDÉS / TELEPÍTHETŐ APP --- */
// HTTPS-en a service worker elmenti az appot, így hálózat nélkül is elindul.
// A HTTP címről (8080) átvisz a HTTPS címre (8443), ha az eszköz megbízik a tanúsítványban,
// és magával viszi az eddigi előzményeket (a két cím külön tárolót kap a böngészőben).
const HTTP_PORT = '8080';
const HTTPS_PORT = '8443';
const MIGRATE_KEYS = ['szorzo_history', 'szorzo_sound', 'szorzo_facts', 'szorzo_pin', 'szorzo_theme'];

function tryUpgradeToHttps() {
    if (location.protocol !== 'http:' || location.port !== HTTP_PORT) return;
    const target = `https://${location.hostname}:${HTTPS_PORT}/`;
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 3000);
    // Csak akkor sikerül, ha a tanúsítvány megbízható ezen az eszközön
    fetch(target + 'manifest.webmanifest', { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal })
        .then(() => {
            if (startTime) return; // már elkezdett tesztet nem szakítunk félbe
            const data = {};
            MIGRATE_KEYS.forEach(k => {
                const v = localStorage.getItem(k);
                if (v !== null) data[k] = v;
            });
            const hash = Object.keys(data).length ? '#import=' + encodeURIComponent(JSON.stringify(data)) : '';
            location.replace(target + hash);
        })
        .catch(() => { /* nincs megbízható HTTPS: maradunk HTTP-n */ });
}

function importMigratedData() {
    if (!location.hash.startsWith('#import=')) return;
    try {
        const data = JSON.parse(decodeURIComponent(location.hash.slice('#import='.length)));
        // Csak üres helyre importálunk, a HTTPS oldalon már meglévő adatot nem írjuk felül
        MIGRATE_KEYS.forEach(k => {
            if (typeof data[k] === 'string' && localStorage.getItem(k) === null) localStorage.setItem(k, data[k]);
        });
    } catch (e) { /* hibás hash: nincs mit importálni */ }
    window.history.replaceState(null, '', location.pathname);
}

/* --- FRISSÍTÉS --- */
// Ha a háttérben új verzió töltődött le, egy sáv jelzi, és pár másodperc múlva magától frissül.
// Teszt közben és az eredmény nézésekor nem frissít, csak utána (beállítások / statisztika képernyőn).
const UPDATE_DELAY_S = 5;
let waitingWorker = null;
let updateTimer = null;

function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    navigator.serviceWorker.register('sw.js').then(reg => {
        const watch = sw => sw.addEventListener('statechange', () => {
            // "installed" + van már működő példány = ez egy új verzió, ami a jelzésünkre vár
            if (sw.state === 'installed' && navigator.serviceWorker.controller) onUpdateReady(sw);
        });
        if (reg.waiting && navigator.serviceWorker.controller) onUpdateReady(reg.waiting);
        if (reg.installing) watch(reg.installing);
        reg.addEventListener('updatefound', () => watch(reg.installing));

        // A telepített app napokig nyitva maradhat: időnként és előtérbe kerüléskor is megnézzük
        setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') reg.update().catch(() => {});
        });
    }).catch(() => { /* nélküle is működik, csak nem offline */ });

    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloading || !waitingWorker) return; // az első telepítéskor nincs mit újratölteni
        reloading = true;
        try {
            sessionStorage.setItem('szorzo_updated', JSON.stringify({
                tables: selectedTables, op: joinOps(currentOps), mode: currentMode, count: questionCountSetting,
            }));
        } catch (e) { /* a beállítások nélkül is frissül */ }
        location.reload();
    });
}

function onUpdateReady(worker) {
    waitingWorker = worker;
    document.getElementById('update-banner').hidden = false;
    scheduleUpdate();
}

function scheduleUpdate() {
    if (!waitingWorker) return;
    clearInterval(updateTimer);
    const text = document.getElementById('update-text');
    const busy = pinFlow || ['screen-quiz', 'screen-results']
        .some(id => document.getElementById(id).classList.contains('active'));
    if (busy) {
        text.innerText = '✨ Új verzió érhető el – a teszt után frissül.';
        return;
    }
    let left = UPDATE_DELAY_S;
    const show = () => { text.innerText = `✨ Új verzió érhető el – frissítés ${left} mp múlva…`; };
    show();
    updateTimer = setInterval(() => {
        if (--left <= 0) applyUpdate();
        else show();
    }, 1000);
}

function applyUpdate() {
    clearInterval(updateTimer);
    if (waitingWorker) waitingWorker.postMessage('SKIP_WAITING');
}

// Frissítés után: üzenet, és a korábbi beállítások (táblák, művelet, mód, darabszám) visszaállítása
function restoreAfterUpdate() {
    let saved = null;
    try {
        saved = JSON.parse(sessionStorage.getItem('szorzo_updated'));
        sessionStorage.removeItem('szorzo_updated');
    } catch (e) { /* nincs mit visszaállítani */ }
    if (!saved) return;

    selectedTables = Array.isArray(saved.tables) ? saved.tables : [];
    renderTableSelector();
    selectOps(parseOps(saved.op));
    const countIndex = [10, 20, 30, 'all'].indexOf(saved.count);
    if (countIndex >= 0) setCount(saved.count, document.querySelectorAll('.btn-count')[countIndex]);
    if (['practice', 'exam', 'weak'].includes(saved.mode)) setMode(saved.mode);
    showToast(`✅ Az app frissült: ${versionText()}`);
}

let toastTimer = null;
function showToast(message) {
    const toast = document.getElementById('toast');
    toast.innerText = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 3500);
}

/* --- VERZIÓ ÉS MEGOSZTÁS --- */
const APP_VERSION = '1.9';
const APP_BUILD = 'dev'; // a közzététel (GitHub Actions) írja át a commit rövid azonosítójára
const APP_URL = 'https://vmynick.github.io/matek-gyakorlo/';

function versionText() {
    return `v${APP_VERSION}` + (APP_BUILD !== 'dev' ? ` (${APP_BUILD})` : '');
}

// Telefonon / tableten a rendszer megosztó menüje, máshol a link a vágólapra kerül
async function shareApp() {
    playSound('click');
    if (navigator.share) {
        try {
            await navigator.share({
                title: 'Szorzótábla Mester',
                text: 'Szorzótábla- és bennfoglalás-gyakorló alsósoknak, ingyen, internet nélkül is:',
                url: APP_URL,
            });
        } catch (e) { /* bezárta a megosztó menüt */ }
        return;
    }
    try {
        await navigator.clipboard.writeText(APP_URL);
        showToast('🔗 A link a vágólapra került');
    } catch (e) {
        showToast(APP_URL);
    }
}
