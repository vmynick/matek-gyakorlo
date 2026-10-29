/* Szorzótábla Mester – a szülői PIN és a gyerek-PIN beírása (közös tableten). */

/* --- SZÜLŐI PIN --- */
// Első használatkor a szülő beállít egy 4 jegyű PIN-t (kétszer beírva), utána ezt kéri.
const PIN_LENGTH = 4;
let pinFlow = null; // { step: 'enter' | 'new' | 'repeat', input, first, onSuccess }

function requireParentPin(onSuccess) {
    const hasPin = localStorage.getItem('szorzo_pin') !== null;
    pinFlow = { step: hasPin ? 'enter' : 'new', input: '', first: null, onSuccess };
    document.getElementById('pin-title').innerText = '👨‍👩‍👧 Szülői PIN';
    showPinStep();
    document.getElementById('pin-overlay').hidden = false;
}

// Közös tableten a gyerek a saját PIN-jével választja ki magát (ha a szülő beállított neki)
function requireChildPin(child, onSuccess, onCancel) {
    pinFlow = { step: 'child', child, input: '', onSuccess, onCancel };
    document.getElementById('pin-title').innerText = `🔒 ${child.avatar} ${child.nickname}`;
    showPinStep();
    document.getElementById('pin-overlay').hidden = false;
}

function showPinStep(error) {
    const texts = {
        enter: 'Add meg a szülői PIN-t.',
        new: 'Még nincs szülői PIN. Állíts be egy 4 jegyű PIN-t!',
        repeat: 'Írd be még egyszer ugyanazt a PIN-t.',
        child: 'Írd be a PIN-edet!',
    };
    const msg = document.getElementById('pin-msg');
    msg.innerText = error || texts[pinFlow.step];
    msg.classList.toggle('error', !!error);
    renderPinDots();
}

function renderPinDots() {
    document.querySelectorAll('#pin-dots i').forEach((dot, i) =>
        dot.classList.toggle('filled', i < pinFlow.input.length));
}

function pinPress(num) {
    if (!pinFlow || pinFlow.input.length >= PIN_LENGTH) return;
    playSound('click');
    pinFlow.input += num;
    renderPinDots();
    if (pinFlow.input.length === PIN_LENGTH) setTimeout(checkPin, 150); // látszódjon a 4. pötty is
}

function pinDelete() {
    if (!pinFlow || pinFlow.input === '') return;
    playSound('delete');
    pinFlow.input = pinFlow.input.slice(0, -1);
    renderPinDots();
}

function checkPin() {
    if (!pinFlow) return;
    const entered = pinFlow.input;
    pinFlow.input = '';

    if (pinFlow.step === 'child') {
        const flow = pinFlow;
        childPinMatches(flow.child, entered).then(ok => {
            if (pinFlow !== flow) return;
            if (ok) return finishPin();
            playSound('wrong');
            showPinStep('Nem ez a PIN, próbáld újra!');
        });
    } else if (pinFlow.step === 'enter') {
        if (entered === localStorage.getItem('szorzo_pin')) return finishPin();
        playSound('wrong');
        showPinStep('Hibás PIN, próbáld újra!');
    } else if (pinFlow.step === 'new') {
        pinFlow.first = entered;
        pinFlow.step = 'repeat';
        showPinStep();
    } else if (entered === pinFlow.first) {
        localStorage.setItem('szorzo_pin', entered);
        finishPin();
    } else {
        playSound('wrong');
        pinFlow.step = 'new';
        showPinStep('A két PIN nem egyezett. Kezdd újra: adj meg egy 4 jegyű PIN-t!');
    }
}

function finishPin() {
    const flow = pinFlow;
    flow.done = true;
    closePin();
    flow.onSuccess();
}

function closePin() {
    const flow = pinFlow;
    pinFlow = null;
    document.getElementById('pin-overlay').hidden = true;
    if (flow && !flow.done && flow.onCancel) flow.onCancel();
    scheduleUpdate();
}

function handlePinKeyboard(e) {
    if (/^[0-9]$/.test(e.key)) pinPress(parseInt(e.key));
    else if (e.key === 'Backspace') pinDelete();
    else if (e.key === 'Escape') closePin();
    else return;
    e.preventDefault();
}
