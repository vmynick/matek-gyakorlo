/* Szorzótábla Mester – a gyakorló app (szorzotabla.html) állapota, hangjai, indulása és a sötét mód.
   Az app kódja témánként külön fájlban van (app/*.js). Az oldal sorban tölti be őket, a változóik és a függvényeik
   közösek. A felső szinten egyik fájl sem hív más fájlban lévő függvényt: minden az oldal betöltése után indul. */

/* --- ALAPAPPLIKÁCIÓ ÁLLAPOT --- */
let selectedTables = []; // Egyik sincs kijelölve az elején
let currentMode = 'practice'; // 'practice', 'exam' vagy 'weak' (hibák gyakorlása)
let currentOps = ['mul']; // a választott műveletek: 'mul' (szorzás), 'div' (osztás), 'mis' (hiányzó tényező), 'rem' (maradékos)
let heatmapOp = 'mul'; // a feladat-térképen mutatott művelet
let questionCountSetting = 20; // 10, 20, 30, vagy 'all'
let soundEnabled = true; // Hangok állapota

// Aktuális futó teszt állapota
let quizMode = 'practice'; // a futó teszt módja: a kiválasztott mód, vagy 'daily' (mai gyakorlás)
let quizDeck = [];
let currentQuestionIndex = 0;
let score = 0;
let errorsCount = 0;
let bonesLeft = 3;
let bonesUsed = 0;
let mistakesList = [];
let bonesList = []; // csonttal javított feladatok a szülői kimutatáshoz
let currentAnswerInput = "";
let currentRemInput = ""; // maradékos osztásnál a maradék
let activeBox = 'main'; // melyik mezőbe ír a billentyűzet: 'main' vagy 'rem' (maradék)
let explainShownAt = null; // végleges hiba után a levezetés látszik; a "Tovább" gombra megy tovább
let isBoneRetryState = false;
let boneFirstAnswer = null; // a csont előtti (rossz) válasz
let questionShownAt = 0; // válaszidő méréséhez
let firstAnswerMs = null;
let currentSessionId = null; // a teszt azonosítója (a felhőben a válaszok ehhez tartoznak)
let currentAssignmentId = null; // ha kiosztott feladatot csinál
let inputLocked = false; // válasz után a következő feladatig nem fogad bevitelt (dupla OK ellen)
let quizRunId = 0; // kilépéskor / új tesztnél a régi időzítők érvénytelenné válnak
let startTime = null;
let chartInstance = null;

// Hang effektek (Web Audio API)
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function toggleSound() {
    soundEnabled = !soundEnabled;
    localStorage.setItem('szorzo_sound', soundEnabled ? '1' : '0');
    updateSoundButton();
    if (soundEnabled) playSound('click');
}

function updateSoundButton() {
    const btn = document.getElementById('sound-btn');
    if (soundEnabled) {
        btn.innerText = '🔊';
        btn.classList.remove('muted');
    } else {
        btn.innerText = '🔇';
        btn.classList.add('muted');
    }
}

function playSound(type) {
    if (!soundEnabled) return; // Néma üzemmód ellenőrzése

    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    const now = audioCtx.currentTime;
    if (type === 'click') {
        // Billentyű gomb kattanás hang
        osc.type = 'sine';
        osc.frequency.setValueAtTime(600, now);
        osc.frequency.exponentialRampToValueAtTime(200, now + 0.05);
        gain.gain.setValueAtTime(0.15, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.05);
        osc.start(now);
        osc.stop(now + 0.05);
    } else if (type === 'delete') {
        // Törlés gomb hang
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(300, now);
        osc.frequency.exponentialRampToValueAtTime(150, now + 0.08);
        gain.gain.setValueAtTime(0.15, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.08);
        osc.start(now);
        osc.stop(now + 0.08);
    } else if (type === 'correct') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(523.25, now); // C5
        osc.frequency.exponentialRampToValueAtTime(659.25, now + 0.15); // E5
        gain.gain.setValueAtTime(0.2, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
        osc.start(now);
        osc.stop(now + 0.3);
    } else if (type === 'wrong') {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(180, now);
        osc.frequency.linearRampToValueAtTime(110, now + 0.2);
        gain.gain.setValueAtTime(0.2, now);
        gain.gain.linearRampToValueAtTime(0.01, now + 0.25);
        osc.start(now);
        osc.stop(now + 0.25);
    } else if (type === 'bone') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(350, now);
        osc.frequency.exponentialRampToValueAtTime(450, now + 0.15);
        gain.gain.setValueAtTime(0.2, now);
        gain.gain.linearRampToValueAtTime(0.01, now + 0.2);
        osc.start(now);
        osc.stop(now + 0.2);
    }
}

// Inicializálás
window.onload = function() {
    importMigratedData();
    tryUpgradeToHttps();
    registerServiceWorker();

    // Hang beállítás betöltése
    const savedSound = localStorage.getItem('szorzo_sound');
    if (savedSound !== null) {
        soundEnabled = savedSound === '1';
    }
    updateSoundButton();

    applyTheme(document.documentElement.dataset.theme);
    document.getElementById('app-version').innerText = `Szorzótábla Mester ${versionText()}`;
    renderTableSelector();
    restoreAfterUpdate();
    updateSetupInfo();

    // Felhő: összekötött eszköz szinkronja; a szülőtől kapott linkben (?kod=...) érkező kód beírása
    updateCloudUI();
    renderAssignments();
    renderStars();
    askWhoIsPracticing();
    cloudSync();
    window.addEventListener('online', () => cloudSync());
    openCloudPanelFromLink();

    // Fizikai billentyűzet támogatás
    window.addEventListener('keydown', handlePhysicalKeyboard);
};

/* --- SÖTÉT MÓD --- */
// Alapból a készülék beállítását követi; a 🌙/☀️ gombbal választott mód felülírja (eszközönként megjegyzi)
function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    document.getElementById('theme-btn').innerText = theme === 'dark' ? '☀️' : '🌙';
    document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#111a2e' : '#4f46e5';
    if (document.getElementById('screen-stats').classList.contains('active')) renderChart();
}

function toggleTheme() {
    playSound('click');
    const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('szorzo_theme', theme); } catch (e) { /* csak most vált */ }
    applyTheme(theme);
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
    let saved = null;
    try { saved = localStorage.getItem('szorzo_theme'); } catch (err) { /* nincs mentett választás */ }
    if (!saved) applyTheme(e.matches ? 'dark' : 'light');
});
