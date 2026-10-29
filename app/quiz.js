/* Szorzótábla Mester – a teszt: indítás, feladatok, válaszadás, segítség rossz válasz után és az eredmény. */

/* --- TESZT GENERÁLÁS ÉS INDÍTÁS --- */
// assignmentId: ha egy kiosztott feladatot indít a gyerek (a teszt eredménye ehhez kötődik)
// mode: a beállított mód, vagy 'daily' (mai gyakorlás)
function startQuiz(assignmentId, mode = currentMode) {
    playSound('click');
    currentAssignmentId = typeof assignmentId === 'string' ? assignmentId : null;
    quizMode = mode;

    // Pakli összeállítása
    let fullDeck;
    if (quizMode === 'daily') {
        fullDeck = dailyQuestions().deck;
    } else if (quizMode === 'weak') {
        // A leggyengébbek kerülnek előre, ha kevesebb feladatot kér a beállítás
        fullDeck = shuffle(weakQuestions()).sort((a, b) => a.score - b.score).map(w => w.q);
        if (fullDeck.length === 0) {
            alert('Nincs gyakorlásra váró hibás feladat. Szuper! 🎉');
            return;
        }
    } else {
        if (selectedTables.length === 0) {
            alert('Kérlek, válassz ki legalább egy táblát!');
            return;
        }
        fullDeck = alternateOps(buildDeck(selectedTables, currentOps));
        if (fullDeck.length === 0) {
            alert('0-val nem lehet osztani. Válassz másik táblát is!');
            return;
        }
    }

    // Feladatszám vágása üzemmód szerint (a kikérdezőben mindig az összes, a mai gyakorlás mindig 10)
    if (quizMode !== 'exam' && quizMode !== 'daily' && questionCountSetting !== 'all') {
        fullDeck = fullDeck.slice(0, Math.min(parseInt(questionCountSetting), fullDeck.length));
    }
    quizDeck = shuffle(fullDeck);

    // Állapot alaphelyzetbe
    currentQuestionIndex = 0;
    score = 0;
    errorsCount = 0;
    bonesLeft = 3;
    bonesUsed = 0;
    mistakesList = [];
    bonesList = [];
    currentAnswerInput = "";
    isBoneRetryState = false;
    quizRunId++;
    currentSessionId = newId();
    startTime = new Date();
    hideExplanation();

    // Képernyő váltás
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById('screen-quiz').classList.add('active');

    document.getElementById('bone-badge').style.display = quizMode !== 'exam' ? 'flex' : 'none';

    updateQuizUI();
    showNextQuestion();
    scheduleUpdate(); // teszt közben nem frissítünk
}

// A feladat a művelet szerint: "8 × 7 = □", "□ × 7 = 56", "38 : 7 = □, maradék □".
// A számok azonosítója minden formában ugyanaz (q-factor1, q-op, q-factor2).
function renderExpression(q) {
    const a = `<span id="q-factor1">${q.f1}</span>`;
    const b = `<span id="q-factor2">${q.f2}</span>`;
    const op = `<span id="q-op">${OP_SYMBOL[q.op]}</span>`;
    const box = `<span class="answer-display active" id="user-answer" onclick="setActiveBox('main')"></span>`;
    document.getElementById('expression').innerHTML = q.op === 'mis'
        ? `${box} ${op} ${b} = ${a}`
        : `${a} ${op} ${b} = ${box}` + (q.op === 'rem'
            ? `<div class="rem-line">maradék: <span class="answer-display" id="user-rem" onclick="setActiveBox('rem')"></span></div>` : '');
}

function showNextQuestion() {
    if (currentQuestionIndex >= quizDeck.length) {
        finishQuiz();
        return;
    }

    const q = quizDeck[currentQuestionIndex];
    renderExpression(q);
    currentAnswerInput = "";
    currentRemInput = "";
    activeBox = 'main';
    document.getElementById('feedback').innerText = "";
    document.getElementById('feedback').className = "feedback-msg";
    document.getElementById('hint').hidden = true;
    isBoneRetryState = false;
    boneFirstAnswer = null;
    inputLocked = false;
    questionShownAt = performance.now();
    firstAnswerMs = null;

    updateQuizUI();
}

// Kis szünet a visszajelzés után, majd jön a következő feladat (ha közben nem léptek ki)
function goToNextQuestionAfter(ms) {
    inputLocked = true;
    const runId = quizRunId;
    setTimeout(() => {
        if (runId !== quizRunId) return;
        currentQuestionIndex++;
        showNextQuestion();
    }, ms);
}

function updateQuizUI() {
    document.getElementById('quiz-score').innerText = score;
    document.getElementById('quiz-errors').innerText = errorsCount;
    document.getElementById('quiz-bones').innerText = bonesLeft;

    const progressPct = (currentQuestionIndex / quizDeck.length) * 100;
    document.getElementById('quiz-progress').style.width = `${progressPct}%`;
}

/* --- BEVITEL ÉS VÁLASZ ADÁS --- */
// A válasz mezői: a fő válasz, és maradékos osztásnál a maradék (koppintással vagy OK-val lehet váltani)
function renderAnswer() {
    const main = document.getElementById('user-answer');
    const rem = document.getElementById('user-rem');
    main.innerText = currentAnswerInput;
    main.classList.toggle('active', activeBox === 'main');
    if (rem) {
        rem.innerText = currentRemInput;
        rem.classList.toggle('active', activeBox === 'rem');
    }
}

function setActiveBox(box) {
    if (inputLocked || !document.getElementById('user-rem')) return;
    activeBox = box;
    renderAnswer();
}

function appendNum(num) {
    const rem = activeBox === 'rem';
    const value = rem ? currentRemInput : currentAnswerInput;
    if (inputLocked || value.length >= (rem ? 2 : 3)) return;
    playSound('click');
    // Vezető nulla helyett az új számjegy kerül be ("07" -> "7")
    const next = value === "0" ? num.toString() : value + num;
    if (rem) currentRemInput = next;
    else currentAnswerInput = next;
    renderAnswer();
}

// ⌫: az utolsó számjegy törlése (az üres maradék mezőből vissza a hányadoshoz)
function deleteDigit() {
    if (inputLocked) return;
    if (activeBox === 'rem' && currentRemInput === "") return setActiveBox('main');
    if (activeBox === 'main' && currentAnswerInput === "") return;
    playSound('delete');
    if (activeBox === 'rem') currentRemInput = currentRemInput.slice(0, -1);
    else currentAnswerInput = currentAnswerInput.slice(0, -1);
    renderAnswer();
}

function clearAnswer() {
    currentAnswerInput = "";
    currentRemInput = "";
    activeBox = 'main';
    renderAnswer();
}

function handlePhysicalKeyboard(e) {
    if (pinFlow) {
        handlePinKeyboard(e);
        return;
    }
    if (!document.getElementById('screen-quiz').classList.contains('active')) return;

    if (/^[0-9]$/.test(e.key)) {
        appendNum(parseInt(e.key));
    } else if (e.key === 'Backspace') {
        deleteDigit();
    } else if (e.key === 'Escape' || e.key === 'Delete') {
        if (!inputLocked) clearAnswer();
    } else if (e.key === 'Enter') {
        if (!e.repeat) submitAnswer();
    } else {
        return;
    }
    // Különben a fókuszban maradt gomb (pl. az előbb kattintott OK) is "megnyomódna"
    e.preventDefault();
}

function submitAnswer() {
    if (explainShownAt !== null) return nextAfterExplain();
    if (inputLocked || currentAnswerInput === "") return;

    const q = quizDeck[currentQuestionIndex];
    // Maradékos osztásnál az első OK a maradék mezőjére visz
    if (q.op === 'rem' && currentRemInput === "") return setActiveBox('rem');
    const given = { main: parseInt(currentAnswerInput), rem: q.op === 'rem' ? parseInt(currentRemInput) : null };
    const givenText = q.op === 'rem' ? `${given.main}, maradék ${given.rem}` : `${given.main}`;
    const fb = document.getElementById('feedback');
    if (firstAnswerMs === null) firstAnswerMs = performance.now() - questionShownAt;

    if (given.main === q.target && (q.op !== 'rem' || given.rem === q.rem)) {
        // HELYES VÁLASZ
        playSound('correct');
        fb.innerText = "Helyes! 🎉";
        fb.className = "feedback-msg feedback-correct";
        document.getElementById('hint').hidden = true;
        score++;
        if (isBoneRetryState) {
            bonesList.push(`${solutionText(q)} (először: ${boneFirstAnswer})`);
            recordFact(q, 'b');
        } else {
            recordFact(q, 'o', firstAnswerMs);
        }
        goToNextQuestionAfter(700);

    } else {
        // HIBÁS VÁLASZ
        if (quizMode !== 'exam' && bonesLeft > 0 && !isBoneRetryState) {
            // Csontos javítási lehetőség, egy tippel (a megoldás nélkül)
            playSound('bone');
            bonesLeft--;
            bonesUsed++;
            isBoneRetryState = true;
            boneFirstAnswer = givenText;

            fb.innerText = "Nem jó! 🦴 Próbáld újra!";
            fb.className = "feedback-msg feedback-bone";
            const hint = document.getElementById('hint');
            hint.innerText = `💡 ${hintFor(q, given)}`;
            hint.hidden = false;
            clearAnswer();
            updateQuizUI();
        } else {
            // Végleges hiba
            playSound('wrong');
            errorsCount++;
            const answers = boneFirstAnswer !== null ? `${boneFirstAnswer}, majd ${givenText}` : givenText;
            mistakesList.push(`${solutionText(q)} (A válaszod: ${answers})`);
            recordFact(q, 'x');

            fb.innerText = `Sajnos nem! A helyes válasz: ${answerText(q)}`;
            fb.className = "feedback-msg feedback-wrong";
            // A szülői kikérdező szigorú teszt: ott nincs levezetés, megy tovább
            if (quizMode === 'exam') goToNextQuestionAfter(1600);
            else showExplanation(q);
        }
    }
}

// Végleges hiba után: a levezetés és a pöttyös ábra a számbillentyűzet helyén, a gyerek lép tovább
function showExplanation(q) {
    inputLocked = true;
    const { text, rows } = explainFor(q);
    document.getElementById('hint').hidden = true;
    document.getElementById('explain-text').innerText = `Így jön ki: ${text}`;
    document.getElementById('explain-dots').innerHTML = rows.map((row, i) =>
        `<div class="dot-row${i && row.kind !== rows[i - 1].kind ? ' split' : ''}">${`<i class="${row.kind}"></i>`.repeat(row.n)}</div>`).join('');
    document.getElementById('numpad').hidden = true;
    document.getElementById('explain').hidden = false;
    explainShownAt = performance.now();
}

function hideExplanation() {
    explainShownAt = null;
    document.getElementById('explain').hidden = true;
    document.getElementById('numpad').hidden = false;
}

// "Tovább": egy dupla koppintás (az OK gomb helyén) még ne ugorja át a levezetést
function nextAfterExplain() {
    if (explainShownAt === null || performance.now() - explainShownAt < 500) return;
    hideExplanation();
    currentQuestionIndex++;
    showNextQuestion();
}

/* --- TESZT BEFEJEZÉSE ÉS EREDMÉNYEK --- */
function finishQuiz() {
    const endTime = new Date();
    const durationSec = Math.round((endTime - startTime) / 1000);
    const mins = Math.floor(durationSec / 60);
    const secs = durationSec % 60;
    const timeStr = `${mins.toString().padStart(2,'0')}:${secs.toString().padStart(2,'0')}`;

    const totalTasks = quizDeck.length;
    const pct = Math.round((score / totalTasks) * 100);

    // Osztályzat / Címke
    let gradeStr = "Próbáld újra!";
    if (pct === 100) gradeStr = "Zseniális! 🏆";
    else if (pct >= 85) gradeStr = "Nagyszerű! 🌟";
    else if (pct >= 70) gradeStr = "Jó munka! 👍";
    else if (pct >= 50) gradeStr = "Gyakorolj még! 💪";

    // Eredmény kijelzés frissítése
    document.getElementById('res-title').innerText = pct >= 50 ? '🎉 Szép munka!' : '💪 Ne add fel!';
    document.getElementById('res-pct').innerText = `${pct}%`;
    document.getElementById('res-grade').innerText = gradeStr;
    const modeNames = { practice: 'Gyakorló Mód', exam: 'Szülői Kikérdező', weak: 'Hibák Gyakorlása', daily: 'Mai Gyakorlás' };
    document.getElementById('res-mode-badge').innerText = modeNames[quizMode];
    document.getElementById('res-total').innerText = `${score}/${totalTasks}`;
    document.getElementById('res-errors').innerText = errorsCount;
    document.getElementById('res-bones-used').innerText = bonesUsed;
    document.getElementById('res-time').innerText = timeStr;

    // Hibák listája
    const mListEl = document.getElementById('res-mistakes-list');
    if (mistakesList.length === 0) {
        mListEl.innerHTML = `<em>Hibátlan teljesítmény, nincs kijavítandó feladat! 🎉</em>`;
    } else {
        mListEl.innerHTML = mistakesList.map(m => `<div>❌ ${m}</div>`).join('');
    }

    // Csonttal javított feladatok: jók lettek, de elsőre nem mentek
    document.getElementById('res-bones-section').style.display = bonesList.length ? 'block' : 'none';
    document.getElementById('res-bones-list').innerHTML = bonesList.map(m => `<div>🦴 ${m}</div>`).join('');

    // Konfetti elindítása magas pontszám esetén
    if (pct >= 80 && typeof confetti === 'function') {
        confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 } });
    }

    // Mentés LocalStorage-ba
    const finishedAt = new Date();
    saveResultToStorage({
        date: finishedAt.toLocaleDateString('hu-HU', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
        pct: pct,
        mode: quizMode,
        at: finishedAt.toISOString()
    });
    // Összekötött eszközön a felhőbe is (internet nélkül sorban vár), és csillag jár érte
    const assignment = currentAssignmentId &&
        JSON.parse(localStorage.getItem('szorzo_assignments') || '[]').find(a => a.id === currentAssignmentId);
    const picked = quizMode !== 'weak' && quizMode !== 'daily'; // a hibák és a mai gyakorlás maga válogat
    const session = {
        id: currentSessionId,
        mode: quizMode,
        op: picked ? joinOps(currentOps) : null,
        tables: picked ? selectedTables : [],
        total: totalTasks,
        correct: score,
        errors: errorsCount,
        bones_used: bonesUsed,
        duration_s: durationSec,
        pct: pct,
        finished_at: finishedAt.toISOString(),
        assignment_id: currentAssignmentId
    };
    cloudQueueSession(session);
    const earned = cloudAddStars(session, !!assignment && !assignment.done);
    const starsLine = document.getElementById('res-stars');
    starsLine.hidden = !linkedChild();
    starsLine.classList.toggle('hint', !earned);
    starsLine.innerText = earned ? `⭐ +${earned} csillag!` : 'Tipp: legalább 10 feladatos tesztért csillag jár ⭐';
    if (currentAssignmentId) {
        cloudMarkAssignmentDone(currentAssignmentId);
        renderAssignments();
    }
    renderStars();

    // Képernyőváltás
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById('screen-results').classList.add('active');
    checkStarNews(); // elért cél?
}
