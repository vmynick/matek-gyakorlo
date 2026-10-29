/* Szorzótábla Mester – a kezdőképernyő beállításai (mód, műveletek, táblák, feladatszám) és a fülek váltása. */

/* --- BEÁLLÍTÁSOK KEZELÉSE --- */
function renderTableSelector() {
    const grid = document.getElementById('tables-grid');
    grid.innerHTML = '';
    for (let i = 0; i <= 10; i++) {
        const btn = document.createElement('button');
        btn.className = `btn-table-select ${selectedTables.includes(i) ? 'selected' : ''}`;
        btn.innerText = `${i}-${TABLE_SUFFIX[i]}`;
        btn.onclick = () => toggleTable(i);
        grid.appendChild(btn);
    }
}

function toggleTable(num) {
    playSound('click');
    if (selectedTables.includes(num)) {
        selectedTables = selectedTables.filter(t => t !== num);
    } else {
        selectedTables.push(num);
        selectedTables.sort((a,b) => a - b);
    }
    renderTableSelector();
    updateSetupInfo();
}

function toggleAllTables() {
    playSound('click');
    if (selectedTables.length === 11) {
        selectedTables = [];
    } else {
        selectedTables = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    }
    renderTableSelector();
    updateSetupInfo();
}

function setMode(mode) {
    playSound('click');
    currentMode = mode;
    ['practice', 'exam', 'weak'].forEach(m =>
        document.getElementById(`mode-${m}`).classList.toggle('selected', mode === m));

    // Hibák gyakorlásánál nincs táblaválasztás: a korábbi hibákból dolgozik
    document.getElementById('table-picker').style.display = mode === 'weak' ? 'none' : 'block';
    document.getElementById('practice-settings').style.display = mode === 'exam' ? 'none' : 'block';
    document.getElementById('exam-settings').style.display = mode === 'exam' ? 'block' : 'none';
    document.getElementById('weak-settings').style.display = mode === 'weak' ? 'block' : 'none';
}

// A műveletgombok kapcsolók: bármelyikek együtt is mehetnek, de az utolsót nem lehet kikapcsolni
function toggleOp(op) {
    if (currentOps.includes(op) && currentOps.length === 1) return;
    playSound('click');
    selectOps(currentOps.includes(op) ? currentOps.filter(o => o !== op) : [...currentOps, op]);
}

// A műveletek beállítása (kattintás, kiosztott feladat, frissítés után)
function selectOps(ops) {
    if (!ops.length) return;
    currentOps = parseOps(joinOps(ops));
    document.querySelectorAll('#table-picker .btn-op').forEach(b => b.classList.toggle('selected', currentOps.includes(b.dataset.op)));
    document.getElementById('tables-label').innerText = currentOps.join() === 'rem' ? 'Válaszd ki az osztókat:' : 'Válaszd ki a táblákat:';
    updateSetupInfo();
}

// Egy gombcsoportban csak a megnyomott gomb legyen kijelölve
function selectInGroup(btn) {
    btn.parentElement.querySelectorAll('button').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
}

function setCount(count, btn) {
    playSound('click');
    questionCountSetting = count;
    const btns = document.querySelectorAll('.btn-count');
    btns.forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
}

function updateSetupInfo() {
    const count = buildDeck(selectedTables, currentOps).length;
    document.getElementById('exam-task-info').innerText =
        `ℹ️ A Kikérdező módban a kiválasztott ${selectedTables.length} db táblából pontosan ${count} feladat lesz kikérdezve.`;

    const weakCount = weakQuestions().length;
    document.getElementById('weak-count-card').innerText = weakCount;
    document.getElementById('weak-task-info').innerText = weakCount
        ? `🎯 ${weakCount} feladat vár gyakorlásra. Ha egy feladat kétszer egymás után elsőre jó, kikerül a listából.`
        : '🎉 Nincs gyakorlásra váró hibás feladat. Szuper!';
    renderDaily();
}

/* --- TAB NAVIGÁCIÓ --- */
function switchTab(tabName) {
    const quizRunning = document.getElementById('screen-quiz').classList.contains('active');
    if (quizRunning && !confirm('Biztosan kilépsz? A mostani teszt eredménye elveszik.')) return;
    quizRunId++; // a félbehagyott teszt függő időzítői már ne lépjenek tovább
    playSound('click');
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    // A Fejlődés fül a képernyő magasságához igazodik (görgetés nélkül kifér)
    document.querySelector('.app-container').classList.toggle('fit-screen', tabName === 'stats');

    if (tabName === 'setup') {
        document.querySelectorAll('.tab-btn')[0].classList.add('active');
        document.getElementById('screen-setup').classList.add('active');
        updateSetupInfo();
    } else if (tabName === 'stats') {
        document.querySelectorAll('.tab-btn')[1].classList.add('active');
        document.getElementById('screen-stats').classList.add('active');
        renderChart();
        renderHeatmap();
    }
    scheduleUpdate(); // ha vár egy frissítés, most már mehet
}
