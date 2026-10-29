/* Szorzótábla Mester – a Fejlődés fül: előzmények, grafikon, feladat-térkép és a statisztika törlése. */

/* --- STATISZTIKA & ADATMENTÉS --- */
function saveResultToStorage(resultObj) {
    let history = JSON.parse(localStorage.getItem('szorzo_history') || '[]');
    history.push(resultObj);
    if (history.length > 20) history.shift(); // Max utolsó 20 teszt
    localStorage.setItem('szorzo_history', JSON.stringify(history));
}

// Törölni csak a szülő tud, PIN-nel
function clearHistory() {
    playSound('click');
    if (linkedChild()) {
        alert('Ez az eszköz össze van kötve, így a statisztikát a szülő vagy a tanár törölheti a szülői felületen.');
        return;
    }
    requireParentPin(() => {
        if (confirm("Biztosan törölni szeretnéd az eddigi statisztikát (grafikon és feladat-térkép)?")) {
            localStorage.removeItem('szorzo_history');
            localStorage.removeItem('szorzo_facts');
            renderChart();
            renderHeatmap();
        }
    });
}

/* --- FELADAT-TÉRKÉP (hőtérkép a szülőknek) --- */
function setHeatmapOp(op, btn) {
    playSound('click');
    heatmapOp = op;
    selectInGroup(btn);
    renderHeatmap();
}

// A térkép műveletei: szorzás és osztás mindig, a többi csak ha már gyakorolta
const HEATMAP_OPS = [['mul', '<b>×</b> Szorzás'], ['div', '➗ Osztás'], ['mis', '🔍 Hiányzó'], ['rem', '🍬 Maradékos']];

function renderHeatmap() {
    const facts = loadFacts();
    const ops = HEATMAP_OPS.filter(([op]) => op === 'mul' || op === 'div' || Object.keys(facts).some(k => k.startsWith(`${op}:`)));
    if (!ops.some(([op]) => op === heatmapOp)) heatmapOp = 'mul';
    document.getElementById('hm-ops').innerHTML = ops.map(([op, label]) =>
        `<button class="btn-op${op === heatmapOp ? ' selected' : ''}" onclick="setHeatmapOp('${op}', this)">${label}</button>`).join('');
    renderHeatmapGrid(document.getElementById('heatmap'), document.getElementById('hm-detail'), facts, heatmapOp);

    const weakCount = weakQuestions().length;
    document.getElementById('weak-summary').innerHTML = weakCount
        ? `🎯 ${weakCount} feladat vár gyakorlásra <button class="btn-weak-go" onclick="practiceWeakNow()">Gyakorold ➔</button>`
        : '🎉 Nincs gyakorlásra váró hibás feladat.';
}

function practiceWeakNow() {
    switchTab('setup');
    setMode('weak');
}

function renderChart() {
    const history = JSON.parse(localStorage.getItem('szorzo_history') || '[]');
    chartInstance = buildProgressChart(document.getElementById('progressChart'), history, chartInstance);
}
