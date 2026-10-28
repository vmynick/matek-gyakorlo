// Automata teszt a Szorzótábla Mesterhez (Playwright, headless Chromium).
// Futtatás:  npm test                      -> a projekt mappát szolgálja ki localhoston
//            node tests/szorzotabla.test.mjs <mappa> [--shots <mappa>]
//            node tests/szorzotabla.test.mjs --url https://meselo.local:8443/
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : null; };
const shotsDir = opt('--shots');
const remoteUrl = opt('--url');
const root = path.resolve(args[0] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.css': 'text/css' };

let swVersion = null; // a frissítés teszthez: ha be van állítva, a sw.js ezzel a verzióval megy ki

function serve(dir) {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/szorzotabla.html';
    const f = path.join(dir, p);
    if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    if (p === '/sw.js' && swVersion) return res.end(fs.readFileSync(f, 'utf8').replace("const VERSION = 'dev';", `const VERSION = '${swVersion}';`));
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(srv)));
}

const results = [];
let browser, base;

async function newPage({ viewport = { width: 800, height: 1100 }, sound = false, offline = false, clock = true, colorScheme = 'light' } = {}) {
  const context = await browser.newContext({ viewport, ignoreHTTPSErrors: true, colorScheme });
  if (offline) await context.route((u) => !u.href.startsWith(base), (r) => r.abort());
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.dialogs = [];
  page.on('dialog', (d) => { page.dialogs.push(d.message()); d.accept(); });
  await page.addInitScript((s) => { if (!localStorage.getItem('szorzo_sound')) localStorage.setItem('szorzo_sound', s); }, sound ? '1' : '0');
  if (clock) await page.clock.install();
  await page.goto(base, { waitUntil: 'load' });
  return page;
}

async function test(name, fn) {
  const checks = [];
  const expect = (ok, msg) => checks.push({ ok: !!ok, msg });
  let page;
  try {
    page = await fn(expect);
    if (page?.errors?.length) expect(false, `JS hiba az oldalon: ${page.errors.join(' | ')}`);
  } catch (e) {
    checks.push({ ok: false, msg: `kivétel: ${e.message.split('\n')[0]}` });
  } finally {
    await page?.context().close().catch(() => {});
  }
  const ok = checks.every((c) => c.ok);
  results.push({ name, ok, checks });
  console.log(`${ok ? 'OK  ' : 'HIBA'}  ${name}`);
  for (const c of checks.filter((c) => !c.ok)) console.log(`        - ${c.msg}`);
}

// --- segédek a felülethez ---
const tick = (page, ms = 2000) => page.clock.runFor(ms);
// A képernyőn látható feladat és a megoldása (a kiírt számokból számolva)
const question = (page) => page.evaluate(() => {
  const a = +document.getElementById('q-factor1').innerText, b = +document.getElementById('q-factor2').innerText;
  const op = document.getElementById('q-op').innerText.trim();
  const kind = document.getElementById('user-rem') ? 'rem'
    : document.querySelector('#expression > :first-child').id === 'user-answer' ? 'mis' : op === ':' ? 'div' : 'mul';
  const ans = kind === 'mul' ? a * b : kind === 'rem' ? Math.floor(a / b) : a / b;
  return { a, b, op, kind, ans, rem: kind === 'rem' ? a % b : null };
});
const screen = (page) => page.evaluate(() => document.querySelector('.screen.active')?.id);
const text = (page, id) => page.evaluate((id) => document.getElementById(id).innerText.trim(), id);
async function pickTables(page, list) { for (const i of list) await page.locator('#tables-grid button').nth(i).click(); }
async function typeOnPad(page, n) { for (const d of String(n)) await page.getByRole('button', { name: d, exact: true }).click(); }
// rem: maradékos osztásnál a maradék (az első OK a maradék mezőjére visz)
async function answer(page, value, okTaps = 1, rem = null) {
  await typeOnPad(page, value);
  if (rem !== null) { await page.locator('.action-submit').click(); await typeOnPad(page, rem); }
  for (let i = 0; i < okTaps; i++) await page.locator('.action-submit').click();
}
async function start(page) { await page.locator('#screen-setup .btn-start').click(); }
// Pontosan ezek a műveletek legyenek kijelölve: a gombok kapcsolók, és az utolsót nem lehet kikapcsolni,
// ezért előbb a kellőket kapcsolja be, aztán a többit ki
async function pickOps(page, ...names) {
  const want = names.map((n) => OPS[n]);
  for (const on of [true, false]) {
    for (const op of Object.values(OPS)) {
      const btn = page.locator(`#table-picker .btn-op[data-op="${op}"]`);
      const selected = await btn.evaluate((b) => b.classList.contains('selected'));
      if (want.includes(op) === on && selected !== on) await btn.click();
    }
  }
}
const OPS = { 'Szorzás': 'mul', 'Osztás': 'div', 'Hiányzó tényező': 'mis', 'Maradékos osztás': 'rem' };
const facts = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('szorzo_facts') || '{}'));
const explainOpen = (page) => page.locator('#explain').isVisible();

// Végigjátssza a tesztet; plan(index, q) -> 'ok' | 'wrong' | 'wrong-then-ok' | 'wrong-wrong' | 'slow-ok'
// Végleges hiba után (gyakorló módban) a levezetésből a "Tovább" gombbal lép tovább.
async function playQuiz(page, plan = () => 'ok', okTaps = 1) {
  const seen = [];
  for (let guard = 0; guard < 200 && (await screen(page)) === 'screen-quiz'; guard++) {
    const q = await question(page);
    seen.push(`${q.a}${q.op}${q.b}`);
    const step = plan(seen.length - 1, q);
    const say = (v, taps = okTaps) => answer(page, v, taps, q.rem);
    if (step === 'wrong-then-ok') { await say(q.ans + 1, 1); await say(q.ans); }
    else if (step === 'wrong-wrong') { await say(q.ans + 1, 1); await say(q.ans + 2); }
    else if (step === 'slow-ok') { await tick(page, 7000); await say(q.ans); }
    else await say(step === 'wrong' ? q.ans + 1 : q.ans);
    await tick(page);
    if (await explainOpen(page)) await page.locator('#explain-next').click();
  }
  return seen;
}

async function main() {
  let srv;
  if (remoteUrl) base = remoteUrl;
  else { srv = await serve(root); base = `http://127.0.0.1:${srv.address().port}/`; }
  browser = await chromium.launch({ channel: process.env.BROWSER || 'chrome' }); // a gépen lévő Chrome (vagy BROWSER=msedge)
  console.log(`Teszt: ${base}${remoteUrl ? '' : `  (${root})`}\n`);

  await test('Betöltés, 0–10 táblák helyes magyar ragokkal', async (expect) => {
    const page = await newPage();
    const labels = await page.locator('#tables-grid button').allInnerTexts();
    expect(labels.length === 11, `11 tábla gomb kell, van: ${labels.length}`);
    const want = ['0-s', '1-es', '2-es', '3-as', '4-es', '5-ös', '6-os', '7-es', '8-as', '9-es', '10-es'];
    const bad = want.filter((w, i) => labels[i] !== w).map((w) => `${labels[want.indexOf(w)]}→${w}`);
    expect(bad.length === 0, `rossz rag: ${bad.join(', ')}`);
    return page;
  });

  await test('Gyakorló mód, 10 helyes válasz', async (expect) => {
    const page = await newPage();
    await pickTables(page, [2, 3, 4]);
    await page.locator('.btn-count', { hasText: '10 db' }).click();
    await start(page);
    const seen = await playQuiz(page);
    expect((await screen(page)) === 'screen-results', 'nem jött meg az eredmény képernyő');
    expect(seen.length === 10 && new Set(seen).size === 10, `10 különböző feladat kell, volt: ${seen.length}`);
    expect((await text(page, 'res-total')) === '10/10', `eredmény: ${await text(page, 'res-total')}`);
    expect((await text(page, 'res-pct')) === '100%', `százalék: ${await text(page, 'res-pct')}`);
    const hist = await page.evaluate(() => JSON.parse(localStorage.getItem('szorzo_history') || '[]'));
    expect(hist.length === 1 && hist[0].pct === 100, 'az előzmény nem mentődött');
    return page;
  });

  await test('Csontok: 3 javítás, utána végleges hiba', async (expect) => {
    const page = await newPage({ sound: true });
    await pickTables(page, [7]);
    await page.locator('.btn-count', { hasText: '10 db' }).click();
    await start(page);
    await playQuiz(page, (i) => (i < 3 ? 'wrong-then-ok' : i === 3 ? 'wrong' : 'ok'));
    expect((await text(page, 'res-total')) === '9/10', `helyes: ${await text(page, 'res-total')} (9/10 kell)`);
    expect((await text(page, 'res-errors')) === '1', `hibák: ${await text(page, 'res-errors')} (1 kell)`);
    expect((await text(page, 'res-bones-used')) === '3', `csontok: ${await text(page, 'res-bones-used')} (3 kell)`);
    expect((await page.locator('#res-mistakes-list > div').count()) === 1, 'a hibalistában 1 sor kell');
    return page;
  });

  await test('Dupla/tripla OK koppintás nem ugrik át feladatot', async (expect) => {
    const page = await newPage();
    await pickTables(page, [5]);
    await page.locator('.btn-count', { hasText: '10 db' }).click();
    await start(page);
    const seen = await playQuiz(page, () => 'ok', 3);
    expect(seen.length === 10, `10 feladatnak kellett megjelennie, csak ${seen.length} jelent meg`);
    expect((await text(page, 'res-total')) === '10/10', `eredmény: ${await text(page, 'res-total')} (10/10 kell)`);

    // rossz válasz duplán koppintva (kikérdező mód, nincs csont)
    await page.locator('.tab-btn').first().click();
    await page.locator('#mode-exam').click();
    await pickTables(page, [5, 1]); // 5 ki, 1 be
    await start(page);
    const seen2 = await playQuiz(page, (i) => (i === 0 ? 'wrong' : 'ok'), 2);
    expect(seen2.length === 11, `11 feladat kellett, ${seen2.length} jelent meg`);
    expect((await text(page, 'res-errors')) === '1', `hibák: ${await text(page, 'res-errors')} (1 kell)`);
    return page;
  });

  await test('Fizikai billentyűzet: Enter egérkattintás után', async (expect) => {
    const page = await newPage();
    await pickTables(page, [3]);
    await page.locator('.btn-count', { hasText: '10 db' }).click();
    await start(page);
    let q = await question(page);
    await answer(page, q.ans); // egérrel, a fókusz az OK gombon marad
    await tick(page);
    q = await question(page);
    await page.keyboard.type(String(q.ans));
    await page.keyboard.press('Enter');
    await tick(page);
    const idx = await page.evaluate(() => currentQuestionIndex);
    const sc = await page.evaluate(() => score);
    expect(idx === 2 && sc === 2, `2 megválaszolt feladat kellett, lett: index=${idx}, pont=${sc}`);
    await page.keyboard.type('12');
    await page.keyboard.press('Backspace');
    expect((await text(page, 'user-answer')) === '1', `⌫ után "1" kell, lett: "${await text(page, 'user-answer')}"`);
    await page.locator('#screen-quiz .action-del').click();
    expect((await text(page, 'user-answer')) === '', '⌫ gomb nem törölt');
    await page.keyboard.type('07');
    expect((await text(page, 'user-answer')) === '7', `vezető nulla: "${await text(page, 'user-answer')}" ("7" kell)`);
    return page;
  });

  await test('Kilépés teszt közben, majd új teszt: nem ugrik feladatot', async (expect) => {
    const page = await newPage();
    await pickTables(page, [4]);
    await start(page);
    const q = await question(page);
    await answer(page, q.ans);
    await page.locator('.tab-btn').nth(1).click(); // azonnal Statisztika fül
    await page.locator('.tab-btn').first().click();
    await start(page);
    await tick(page); // a régi időzítő itt sülne el
    const idx = await page.evaluate(() => currentQuestionIndex);
    expect(idx === 0, `az új teszt ${idx + 1}. feladatnál tart (1. kell)`);
    expect((await screen(page)) === 'screen-quiz', `képernyő: ${await screen(page)}`);
    return page;
  });

  await test('Szülői kikérdező, mind a 11 tábla: 121 feladat, mind egyszer', async (expect) => {
    const page = await newPage();
    await page.locator('#mode-exam').click();
    await page.getByText('Mind / Egyik sem').click();
    await start(page);
    expect(!(await page.locator('#bone-badge').isVisible()), 'csont jelző nem látszhat kikérdező módban');
    const seen = await playQuiz(page);
    expect(seen.length === 121, `121 feladat kell, volt: ${seen.length}`);
    expect(new Set(seen).size === 121, `ismétlődő feladat: ${seen.length - new Set(seen).size} db`);
    expect((await text(page, 'res-total')) === '121/121', `eredmény: ${await text(page, 'res-total')}`);
    return page;
  });

  await test('Internet nélkül (CDN elérhetetlen): eredmény + grafikon', async (expect) => {
    const page = await newPage({ offline: true });
    await pickTables(page, [2]);
    await page.locator('.btn-count', { hasText: '10 db' }).click();
    await start(page);
    await playQuiz(page);
    expect((await screen(page)) === 'screen-results', `100% után az eredmény képernyő kell, ehelyett: ${await screen(page)}`);
    await page.locator('.tab-btn').nth(1).click();
    await tick(page, 1500);
    expect(await page.evaluate(() => !!window.Chart), 'Chart.js nem töltődött be');
    return page;
  });

  await test('Statisztika grafikon + törlés csak szülői PIN-nel', async (expect) => {
    const page = await newPage();
    const playExam = async (plan) => {
      await page.locator('.tab-btn').first().click();
      await page.locator('#mode-exam').click();
      if (!(await page.locator('#tables-grid button').nth(6).evaluate((b) => b.classList.contains('selected')))) await pickTables(page, [6]);
      await start(page);
      await playQuiz(page, plan);
      await page.locator('.tab-btn').nth(1).click();
      await tick(page, 1500);
    };
    const histLen = () => page.evaluate(() => JSON.parse(localStorage.getItem('szorzo_history') || '[]').length);
    const pin = async (digits) => {
      for (const d of digits) await page.locator('#pin-overlay').getByRole('button', { name: d, exact: true }).click();
      await tick(page, 500);
    };
    const overlayOpen = () => page.locator('#pin-overlay').isVisible();

    await playExam(() => 'ok');
    await playExam((i) => (i < 5 ? 'wrong' : 'ok'));
    const pts = await page.evaluate(() => chartInstance?.data.datasets[0].data);
    expect(JSON.stringify(pts) === '[100,55]', `grafikon adatai: ${JSON.stringify(pts)} ([100,55] kell)`);

    // Első alkalom: PIN beállítása (kétszer), utána törlés
    await page.locator('.btn-clear').click();
    expect(await overlayOpen(), 'nem jelent meg a PIN ablak');
    expect((await text(page, 'pin-msg')).includes('Még nincs'), `üzenet: ${await text(page, 'pin-msg')}`);
    await pin('1234');
    expect((await text(page, 'pin-msg')).includes('még egyszer'), `üzenet: ${await text(page, 'pin-msg')}`);
    await pin('1234');
    expect(!(await overlayOpen()) && (await histLen()) === 0, 'PIN beállítás után nem törlődött');
    expect((await page.evaluate(() => localStorage.getItem('szorzo_pin'))) === '1234', 'a PIN nem mentődött');

    // Rossz PIN és Mégse: nem töröl
    await playExam(() => 'ok');
    await page.locator('.btn-clear').click();
    await pin('9999');
    expect((await overlayOpen()) && (await text(page, 'pin-msg')).includes('Hibás'), `rossz PIN után: ${await text(page, 'pin-msg')}`);
    await page.locator('#pin-overlay .pin-cancel').click();
    expect(!(await overlayOpen()) && (await histLen()) === 1, 'rossz PIN / Mégse után törlődött vagy nyitva maradt');

    // Jó PIN billentyűzetről
    await page.locator('.btn-clear').click();
    await page.keyboard.type('1234');
    await tick(page, 500);
    expect(!(await overlayOpen()) && (await histLen()) === 0, 'jó PIN után nem törlődött');
    expect((await page.locator('#heatmap .hm-none').count()) === 121, 'a feladat-térkép nem ürült ki');
    return page;
  });

  await test('Keverés egyenletessége (3000 keverés)', async (expect) => {
    const page = await newPage();
    await page.locator('#mode-exam').click();
    await pickTables(page, [1]);
    const firstCounts = await page.evaluate(() => {
      const c = Array(11).fill(0);
      for (let i = 0; i < 3000; i++) { startQuiz(); c[quizDeck[0].other]++; }
      return c;
    });
    const exp = 3000 / 11;
    const chi = firstCounts.reduce((s, o) => s + (o - exp) ** 2 / exp, 0);
    expect(chi < 29.6, `nem egyenletes (chi²=${chi.toFixed(1)}, határ 29.6); első helyen: ${firstCounts.join(',')}`);
    return page;
  });

  await test('Szorzás sorrendje: 4-es tábla = 0 × 4, 1 × 4 … 10 × 4', async (expect) => {
    const page = await newPage();
    await page.locator('#mode-exam').click();
    await pickTables(page, [4]);
    await start(page);
    const qs = [];
    await playQuiz(page, (i, q) => { qs.push(q); return 'ok'; });
    const firsts = qs.map((q) => q.a).sort((x, y) => x - y).join(',');
    expect(qs.every((q) => q.op === '×' && q.b === 4), `a tábla a második helyen kell: ${qs.map((q) => `${q.a}×${q.b}`).join(' ')}`);
    expect(firsts === '0,1,2,3,4,5,6,7,8,9,10', `első tényezők: ${firsts}`);
    return page;
  });

  await test('Osztás (bennfoglalás): 7-es tábla kikérdezve', async (expect) => {
    const page = await newPage();
    await page.locator('#mode-exam').click();
    await pickOps(page, 'Osztás');
    await pickTables(page, [7]);
    expect((await text(page, 'exam-task-info')).includes('11 feladat'), `info: ${await text(page, 'exam-task-info')}`);
    await start(page);
    const qs = [];
    const seen = await playQuiz(page, (i, q) => { qs.push(q); return 'ok'; });
    expect(seen.length === 11 && new Set(seen).size === 11, `11 különböző feladat kell, volt: ${seen.length}`);
    expect(qs.every((q) => q.op === ':' && q.b === 7 && q.a % 7 === 0), `nem 7-es bennfoglalás: ${seen.join(' ')}`);
    expect((await text(page, 'res-total')) === '11/11', `eredmény: ${await text(page, 'res-total')}`);
    return page;
  });

  await test('Osztás csak a 0-s táblával nem indul (0-val nem osztunk)', async (expect) => {
    const page = await newPage();
    await pickOps(page, 'Osztás');
    await pickTables(page, [0]);
    await start(page);
    expect((await screen(page)) === 'screen-setup', 'elindult a teszt');
    expect(page.dialogs.some((m) => m.includes('0-val')), `üzenet: ${page.dialogs.join(' | ')}`);
    return page;
  });

  await test('Több művelet: 2-es tábla szorzás + osztás = 11 + 11, az utolsó művelet nem kapcsolható ki', async (expect) => {
    const page = await newPage();
    const selectedOps = () => page.evaluate(() =>
      [...document.querySelectorAll('#table-picker .btn-op.selected')].map((b) => b.dataset.op).join());
    await page.locator('#table-picker .btn-op[data-op="mul"]').click(); // az egyetlen kijelölt: marad
    expect((await selectedOps()) === 'mul', `az utolsó művelet kikapcsolható volt: "${await selectedOps()}"`);
    await page.locator('#mode-exam').click();
    await pickOps(page, 'Szorzás', 'Osztás');
    expect((await selectedOps()) === 'mul,div', `kijelölve: ${await selectedOps()}`);
    await pickTables(page, [2]);
    expect((await text(page, 'exam-task-info')).includes('22 feladat'), `info: ${await text(page, 'exam-task-info')}`);
    await start(page);
    const seen = await playQuiz(page);
    const mul = seen.filter((s) => s.includes('×')).length, div = seen.filter((s) => s.includes(':')).length;
    expect(mul === 11 && div === 11 && new Set(seen).size === 22, `szorzás: ${mul}, osztás: ${div}, különböző: ${new Set(seen).size}`);
    return page;
  });

  await test('Több művelet, kevés feladat: mindegyikből ugyanannyi jut (a maradékosból sokkal több van)', async (expect) => {
    const page = await newPage();
    await pickOps(page, 'Szorzás', 'Hiányzó tényező', 'Maradékos osztás');
    expect((await text(page, 'tables-label')).includes('táblákat'), `felirat: ${await text(page, 'tables-label')}`);
    await pickTables(page, [9]);
    await page.locator('.btn-count', { hasText: '30 db' }).click();
    const counts = await page.evaluate(() => {
      const out = [];
      for (let i = 0; i < 20; i++) {
        startQuiz();
        const c = { mul: 0, mis: 0, rem: 0 };
        quizDeck.forEach((q) => c[q.op]++);
        out.push(`${c.mul}/${c.mis}/${c.rem}`);
      }
      return [...new Set(out)];
    });
    expect(counts.join() === '10/10/10', `szorzás/hiányzó/maradékos megoszlás: ${counts.join(' ')} (10/10/10 kell)`);
    await playQuiz(page); // az utoljára indított teszt
    const keys = Object.keys(await facts(page));
    const ops = [...new Set(keys.map((k) => k.split(':')[0]))].sort().join();
    expect((await text(page, 'res-total')) === '30/30' && ops === 'mis,mul,rem', `eredmény: ${await text(page, 'res-total')}, műveletek: ${ops}`);
    return page;
  });

  await test('Szülői kimutatás: csonttal javított és kétszer rontott feladat', async (expect) => {
    const page = await newPage();
    await pickTables(page, [6]);
    await page.locator('.btn-count', { hasText: '10 db' }).click();
    await start(page);
    const seen = await playQuiz(page, (i) => (i === 0 ? 'wrong-then-ok' : i === 1 ? 'wrong-wrong' : 'ok'));
    const bones = await page.locator('#res-bones-list > div').allInnerTexts();
    const mistakes = await page.locator('#res-mistakes-list > div').allInnerTexts();
    expect(bones.length === 1 && bones[0].includes('először'), `csontos lista: ${JSON.stringify(bones)}`);
    expect(mistakes.length === 1 && mistakes[0].includes('majd'), `hibalista: ${JSON.stringify(mistakes)}`);
    expect((await text(page, 'res-total')) === '9/10', `eredmény: ${await text(page, 'res-total')}`);
    const f = await facts(page);
    const key = (s) => { const [other, table] = s.split('×'); return `mul:${table}:${other}`; };
    const rs = seen.slice(0, 3).map((s) => f[key(s)]?.r);
    expect(JSON.stringify(rs) === '["b","x","o"]', `feladatonkénti eredmény: ${JSON.stringify(rs)} (["b","x","o"] kell)`);
    return page;
  });

  await test('Feladat-térkép: színek, lassú jelzés, részletek, osztás nézet', async (expect) => {
    const page = await newPage();
    await pickTables(page, [6]);
    await page.locator('.btn-count', { hasText: '10 db' }).click();
    await start(page);
    const plan = (i) => ['wrong-then-ok', 'wrong-wrong', 'ok', 'slow-ok'][i] || 'ok';
    const seen = await playQuiz(page, plan);
    await page.locator('.tab-btn').nth(1).click();
    await tick(page, 1500);
    const cells = () => page.locator('#heatmap .hm-cell').count();
    expect((await cells()) === 144, `szorzás térkép: ${await cells()} mező (144 kell)`);
    const cell = (s) => page.locator(`#heatmap .hm-cell[title^="${s.replace('×', ' × ')} ="]`);
    const cls = async (s) => (await cell(s).getAttribute('class')) || '';
    expect((await cls(seen[0])).includes('hm-l2'), `csontos mező: ${await cls(seen[0])} (hm-l2 kell)`);
    expect((await cls(seen[1])).includes('hm-l0'), `hibás mező: ${await cls(seen[1])} (hm-l0 kell)`);
    expect((await cls(seen[2])).includes('hm-l4') && !(await cls(seen[2])).includes('slow'), `jó mező: ${await cls(seen[2])}`);
    expect((await cls(seen[3])).includes('slow'), `lassú mező: ${await cls(seen[3])} (slow kell)`);
    expect((await page.locator('#heatmap .hm-none').count()) === 111, 'a nem gyakorolt 111 mező legyen szürke');
    await cell(seen[1]).click();
    const detail = await text(page, 'hm-detail');
    expect(detail.includes('❌ 1') && detail.includes('gyakorlásra vár'), `részletek: ${detail}`);
    await cell(seen[3]).click();
    const secs = parseFloat(((await text(page, 'hm-detail')).match(/átlag ([\d,]+) mp/)?.[1] || '0').replace(',', '.'));
    expect(secs >= 7, `lassú válasz átlagideje: ${secs} mp (legalább 7 kell)`);
    expect((await text(page, 'weak-summary')).includes('2 feladat'), `gyakorlásra vár: ${await text(page, 'weak-summary')}`);
    await page.locator('.heatmap-card .btn-op', { hasText: 'Osztás' }).click();
    expect((await cells()) === 132, `osztás térkép: ${await cells()} mező (132 kell)`);
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, 'terkep.png'), fullPage: true });
    await page.locator('.btn-weak-go').click();
    expect((await screen(page)) === 'screen-setup' && (await page.locator('#mode-weak.selected').count()) === 1,
      'a "Gyakorold most" gomb nem a hibák gyakorlására vitt');
    return page;
  });

  await test('Hibák gyakorlása: a rontottak jönnek, két jó kör után kikerülnek', async (expect) => {
    const page = await newPage();
    await page.locator('#mode-exam').click();
    await pickTables(page, [3]);
    await start(page);
    const seen = await playQuiz(page, (i) => (i < 3 ? 'wrong' : 'ok'));
    const wrong = seen.slice(0, 3).sort();
    await page.locator('#screen-results .btn-start').click();
    expect((await text(page, 'weak-count-card')) === '3', `a kártyán ${await text(page, 'weak-count-card')} áll (3 kell)`);
    await page.locator('#mode-weak').click();
    expect(!(await page.locator('#tables-grid').isVisible()), 'ebben a módban nem kell táblaválasztó');
    for (let round = 1; round <= 2; round++) {
      await start(page);
      const got = await playQuiz(page);
      expect(JSON.stringify(got.sort()) === JSON.stringify(wrong), `${round}. kör: ${got.join(' ')} (várt: ${wrong.join(' ')})`);
      expect((await text(page, 'res-mode-badge')) === 'Hibák Gyakorlása', `mód címke: ${await text(page, 'res-mode-badge')}`);
      await page.locator('#screen-results .btn-start').click();
    }
    expect((await text(page, 'weak-count-card')) === '0', `két jó kör után ${await text(page, 'weak-count-card')} maradt (0 kell)`);
    await start(page);
    expect((await screen(page)) === 'screen-setup' && page.dialogs.some((m) => m.includes('Nincs gyakorlásra')), 'üres listával nem indulhat');
    return page;
  });

  await test('Mai gyakorlás: új gyereknek a 2-es tábla, másnap a hibák, az ismétlések és új feladatok', async (expect) => {
    const page = await newPage();
    const info = await text(page, 'daily-info');
    expect(info.includes('✨ 10 új') && !info.includes('javítás'), `kártya új gyereknek: ${info}`);
    await page.locator('#daily-btn').click();
    const first = await page.evaluate(() => quizDeck.map(factKey));
    expect(first.length === 10 && first.every((k) => k.startsWith('mul:2:')), `első nap: ${first.join(' ')} (10 feladat a 2-es táblából)`);
    expect(await page.locator('#bone-badge').isVisible(), 'a mai gyakorlásban is jár csont');
    await playQuiz(page, (i) => (i < 4 ? 'wrong' : 'ok')); // 3 csont, a 4. végleges hiba
    expect((await text(page, 'res-mode-badge')) === 'Mai Gyakorlás', `mód címke: ${await text(page, 'res-mode-badge')}`);
    const hist = await page.evaluate(() => JSON.parse(localStorage.getItem('szorzo_history')));
    expect(hist.length === 1 && hist[0].mode === 'daily', `előzmény: ${JSON.stringify(hist)}`);
    await page.locator('#screen-results .btn-start').click();
    expect((await text(page, 'daily-title')).includes('megvan') && (await text(page, 'daily-btn')).includes('Még egy'),
      `a kártya a gyakorlás után: ${await text(page, 'daily-title')}`);

    // Másnap: a hibás elöl, aztán az esedékes ismétlések és új feladatok
    const f = await facts(page);
    const weak = Object.keys(f).filter((k) => /[bx]/.test(f[k].r));
    await page.clock.fastForward('24:00:00');
    await page.locator('.tab-btn').first().click();
    const info2 = await text(page, 'daily-info');
    expect(info2.includes(`🎯 ${weak.length} javítás`) && info2.includes('🔁') && info2.includes('✨ 3 új'), `másnap: ${info2}`);
    await page.locator('#daily-btn').click();
    const second = await page.evaluate(() => quizDeck.map(factKey));
    const fresh = second.filter((k) => !f[k]);
    expect(weak.every((k) => second.includes(k)), `a hibás feladatok (${weak.join(' ')}) nincsenek benne: ${second.join(' ')}`);
    expect(second.length === 10 && fresh.length === 3, `másnap: ${second.join(' ')} (10 feladat, ebből 3 új)`);
    expect(fresh.includes('mul:2:' + [...Array(11).keys()].find((o) => !f[`mul:2:${o}`])),
      `a 2-es tábla kimaradt feladata nincs az újak között: ${fresh.join(' ')}`);

    // Ismétlés: 1, 2, 4, 7, 14 nap után; a lassú legfeljebb 2 naponta
    const due = await page.evaluate(() => {
      const now = Date.now(), day = 86400000;
      const fact = (r, daysAgo, ms = [2000]) => ({ n: r.length, ok: 0, bone: 0, bad: 0, r, ms, t: now - daysAgo * day });
      return [reviewDue(fact('o', 1), now), reviewDue(fact('oo', 1), now), reviewDue(fact('oo', 2), now),
        reviewDue(fact('ooooo', 7), now), reviewDue(fact('ooooo', 14), now), reviewDue(fact('ooooo', 2, [7000]), now)];
    });
    expect(JSON.stringify(due) === '[1,0.5,1,0.5,1,1]', `esedékesség: ${JSON.stringify(due)} ([1,0.5,1,0.5,1,1] kell)`);
    return page;
  });

  await test('Hiányzó tényező: ? × 7 = 56, a mező elöl, kikérdezve és a térképen', async (expect) => {
    const page = await newPage();
    await page.locator('#mode-exam').click();
    await pickOps(page, 'Hiányzó tényező');
    await pickTables(page, [7]);
    expect((await text(page, 'exam-task-info')).includes('11 feladat'), `info: ${await text(page, 'exam-task-info')}`);
    await start(page);
    const shown = await page.evaluate(() => document.getElementById('expression').innerText.replace(/\s+/g, ' ').trim());
    const q = await question(page);
    expect(q.kind === 'mis' && q.b === 7 && q.a % 7 === 0 && shown === `× 7 = ${q.a}`, `a feladat: "${shown}"`);
    const seen = await playQuiz(page);
    expect(seen.length === 11 && new Set(seen).size === 11, `11 különböző feladat kell, volt: ${seen.length}`);
    expect((await text(page, 'res-total')) === '11/11', `eredmény: ${await text(page, 'res-total')}`);
    const keys = Object.keys(await facts(page));
    expect(keys.length === 11 && keys.every((k) => k.startsWith('mis:7:')), `feladatok: ${keys.join(' ')}`);
    await page.locator('.tab-btn').nth(1).click();
    await tick(page, 1500);
    await page.locator('#hm-ops .btn-op', { hasText: 'Hiányzó' }).click();
    const cells = await page.locator('#heatmap .hm-cell').count();
    const colored = await page.locator('#heatmap .hm-cell:not(.hm-none):not(.hm-head)').count();
    expect(cells === 132 && colored === 11, `térkép: ${cells} mező, ${colored} színes (132 és 11 kell)`);
    await page.locator('#heatmap .hm-cell[title^="? × 7 = 56"]').click();
    expect((await text(page, 'hm-detail')).includes('? × 7 = 56 → 8'), `részletek: ${await text(page, 'hm-detail')}`);
    return page;
  });

  await test('Maradékos osztás: két mező, célzott tipp, levezetés, térkép', async (expect) => {
    const page = await newPage();
    await pickOps(page, 'Maradékos osztás');
    expect((await text(page, 'tables-label')).includes('osztókat'), `felirat: ${await text(page, 'tables-label')}`);
    await pickTables(page, [7]);
    await page.locator('.btn-count', { hasText: '10 db' }).click();
    await start(page);
    const q = await question(page);
    expect(q.kind === 'rem' && q.b === 7 && q.a >= 7 && q.a < 70, `a feladat: ${q.a} : ${q.b}`);
    // Az első OK a maradék mezőjére visz; az üres maradékból a ⌫ vissza
    await typeOnPad(page, q.ans);
    await page.locator('.action-submit').click();
    const active = () => page.evaluate(() => document.querySelector('.answer-display.active')?.id);
    expect((await active()) === 'user-rem', `aktív mező az OK után: ${await active()}`);
    await page.locator('#screen-quiz .action-del').click();
    expect((await active()) === 'user-answer', `aktív mező a ⌫ után: ${await active()}`);
    await page.locator('#user-rem').click();
    // A maradék nem lehet nagyobb az osztónál: célzott tipp
    await typeOnPad(page, 9);
    await page.locator('.action-submit').click();
    expect((await text(page, 'hint')).includes('kisebb, mint az osztó (7)'), `tipp: ${await text(page, 'hint')}`);
    await answer(page, q.ans, 1, q.rem);
    await tick(page);
    // Rossz hányados: tipp a szomszédos szorzatokkal, aztán a levezetés pöttyökkel
    const q2 = await question(page);
    await answer(page, q2.ans + 1, 1, q2.rem);
    expect((await text(page, 'hint')).includes(`${q2.ans * 7}`), `tipp: ${await text(page, 'hint')}`);
    await answer(page, q2.ans + 2, 1, q2.rem);
    expect(await explainOpen(page) && !(await page.locator('#numpad').isVisible()), 'végleges hiba után nem a levezetés látszik');
    expect((await text(page, 'explain-text')).includes(`= ${q2.ans}, maradék ${q2.rem}`), `levezetés: ${await text(page, 'explain-text')}`);
    const dots = await page.evaluate(() => ({ a: document.querySelectorAll('#explain-dots i.a').length,
      rest: document.querySelectorAll('#explain-dots i.rest').length }));
    expect(dots.a === q2.ans * 7 && dots.rest === q2.rem, `pöttyök: ${JSON.stringify(dots)}`);
    await tick(page);
    await page.locator('#explain-next').click();
    await playQuiz(page);
    expect((await text(page, 'res-total')) === '9/10', `eredmény: ${await text(page, 'res-total')} (9/10 kell)`);
    expect((await page.locator('#res-mistakes-list').innerText()).includes('maradék'), 'a hibalistában nincs ott a maradék');
    const keys = Object.keys(await facts(page));
    expect(keys.length === 10 && keys.every((k) => /^rem:7:\d+$/.test(k) && +k.split(':')[2] >= 7 && +k.split(':')[2] < 70),
      `feladatok: ${keys.join(' ')}`);
    await page.locator('.tab-btn').nth(1).click();
    await tick(page, 1500);
    await page.locator('#hm-ops .btn-op', { hasText: 'Maradékos' }).click();
    const cells = await page.locator('#heatmap .hm-cell').count();
    expect(cells === 110, `maradékos térkép: ${cells} mező (110 kell: 10 osztó és 9 hányados, fejléccel)`);
    await page.locator('#heatmap .hm-cell:not(.hm-none):not(.hm-head)').first().click();
    expect((await text(page, 'hm-detail')).includes('válasz'), `részletek: ${await text(page, 'hm-detail')}`);
    return page;
  });

  await test('Segítség: tipp csontnál, levezetés pöttyökkel; minden feladatra helyes számolás', async (expect) => {
    const page = await newPage();
    await pickTables(page, [9]);
    await page.locator('.btn-count', { hasText: '10 db' }).click();
    await start(page);
    const q = await question(page);
    await answer(page, q.ans + 1);
    const hint = await text(page, 'hint');
    expect(hint.startsWith('💡') && (q.ans <= 10 || !new RegExp(`(^|\\D)${q.ans}(\\D|$)`).test(hint)), `tipp (${q.a} × 9): ${hint}`);
    await answer(page, q.ans + 2);
    expect(await explainOpen(page), 'végleges hiba után nincs levezetés');
    const dots = await page.locator('#explain-dots i:not(.ghost)').count();
    expect(dots === q.ans, `pöttyök: ${dots} (${q.ans} kell)`);
    await page.locator('#explain-next').click(); // dupla koppintás: még nem lép tovább
    expect(await explainOpen(page), 'azonnali koppintásra átugrotta a levezetést');
    await tick(page, 600);
    await page.keyboard.press('Enter');
    expect(!(await explainOpen(page)) && (await page.locator('#numpad').isVisible())
      && (await page.evaluate(() => currentQuestionIndex)) === 1, 'Enterre nem ment tovább a következő feladatra');

    // Minden feladat levezetése: a láncban minden tag ugyanannyi, a pöttyök száma is egyezik, a tipp nem árulja el
    const bad = await page.evaluate(() => {
      const out = [];
      const value = (s) => Function(`return (${s.replace(/×/g, '*').replace(/−/g, '-').replace(/ : /g, '/').replace(/^(.*) fele$/, '($1)/2')})`)();
      const all = [];
      for (const [op, lo] of [['mul', 0], ['div', 1], ['mis', 1]]) for (let t = lo; t <= 10; t++) for (let o = 0; o <= 10; o++) all.push(makeQuestion(op, t, o));
      for (let t = 1; t <= 10; t++) for (let n = t; n < 10 * t; n++) all.push(makeQuestion('rem', t, n));
      for (const q of all) {
        const { text, rows } = explainFor(q);
        const dots = rows.filter((r) => r.kind !== 'ghost').reduce((s, r) => s + r.n, 0);
        if (dots !== (q.op === 'mul' ? q.target : q.f1)) out.push(`${solutionText(q)}: ${dots} pötty`);
        if (q.op === 'mul' && text.split(' = ').some((s) => value(s) !== q.target)) out.push(`hibás levezetés: ${text}`);
        if (q.op !== 'mul' && !text.includes(q.op === 'rem' ? `= ${q.target}, maradék ${q.rem},` : `${q.other} × ${q.table} = ${q.f1}`)) {
          out.push(`hibás levezetés: ${text}`);
        }
        const tip = hintFor(q, {});
        if (!tip || tip.includes('undefined') || tip.includes('NaN')) out.push(`hibás tipp: ${solutionText(q)}: ${tip}`);
        if (q.op === 'mul' && q.target > 10 && new RegExp(`(^|\\D)${q.target}(\\D|$)`).test(tip)) out.push(`a tipp elárulja: ${solutionText(q)}: ${tip}`);
      }
      return { count: all.length, out };
    });
    expect(bad.count === 121 + 110 + 110 + 495 && !bad.out.length, `${bad.count} feladat, hibák: ${bad.out.slice(0, 5).join(' | ')}`);
    return page;
  });

  await test('Verziószám és a link megosztása', async (expect) => {
    const page = await newPage();
    const appUrl = 'https://vmynick.github.io/matek-gyakorlo/';
    const ver = await text(page, 'app-version');
    expect(/^Szorzótábla Mester v\d+\.\d+( \([0-9a-f]{7}\))?$/.test(ver), `verzió felirat: "${ver}"`);
    if (remoteUrl) expect(/\([0-9a-f]{7}\)$/.test(ver), `élesben a közzétételi azonosító is kell: "${ver}"`);

    // Megosztó menü nélkül (pl. gépen): a link a vágólapra kerül
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(base).origin });
    await page.evaluate(() => Object.defineProperty(navigator, 'share', { value: undefined, configurable: true }));
    await page.locator('.app-footer .link-btn', { hasText: 'Link megosztása' }).click();
    await tick(page, 100);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip === appUrl, `vágólap: ${clip}`);
    expect((await text(page, 'toast')).includes('vágólapra'), `üzenet: ${await text(page, 'toast')}`);

    // Telefonon / tableten: a rendszer megosztó menüje kapja a linket
    await page.evaluate(() => Object.defineProperty(navigator, 'share', {
      configurable: true, value: (data) => { window.megosztva = data; return Promise.resolve(); } }));
    await page.locator('.app-footer .link-btn', { hasText: 'Link megosztása' }).click();
    const shared = await page.evaluate(() => window.megosztva);
    expect(shared?.url === appUrl && shared?.title === 'Szorzótábla Mester', `megosztott adat: ${JSON.stringify(shared)}`);
    return page;
  });

  await test('Sötét mód: a rendszert követi, a gomb vált és megjegyzi', async (expect) => {
    const page = await newPage({ colorScheme: 'dark', viewport: { width: 412, height: 915 } });
    const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
    const cardBg = () => page.evaluate(() => getComputedStyle(document.querySelector('.app-container')).backgroundColor);
    expect((await theme()) === 'dark', `sötét rendszernél: ${await theme()}`);
    expect((await cardBg()) === 'rgb(17, 26, 46)', `a kártya háttere: ${await cardBg()}`);
    expect((await text(page, 'theme-btn')) === '☀️', `a gomb ikonja: ${await text(page, 'theme-btn')}`);
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, 'sotet-1-beallitas.png'), fullPage: true });
    await pickTables(page, [7]);
    await page.locator('.btn-count', { hasText: '10 db' }).click();
    await start(page);
    const q = await question(page);
    await answer(page, q.ans + 1);
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, 'sotet-2-feladat.png') });
    await answer(page, q.ans);
    await tick(page);
    await playQuiz(page, (i) => (i % 4 === 0 ? 'wrong' : 'ok'));
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, 'sotet-3-eredmeny.png'), fullPage: true });
    await page.locator('.tab-btn').nth(1).click();
    await tick(page, 1500);
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, 'sotet-4-statisztika.png') });

    await page.locator('#theme-btn').click();
    expect((await theme()) === 'light' && (await cardBg()) === 'rgb(255, 255, 255)', 'a gombra nem lett világos');
    await page.reload({ waitUntil: 'load' });
    expect((await theme()) === 'light', 'újratöltés után nem maradt meg a választott világos mód');
    return page;
  });

  if (!remoteUrl) await test('Frissítés: jelzi, teszt közben vár, utána magától frissít', async (expect) => {
    swVersion = null;
    const page = await newPage({ clock: false });
    await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 10000 });
    await pickTables(page, [2]);
    await pickOps(page, 'Szorzás', 'Osztás');
    await start(page);
    await page.evaluate(() => { window.regiOldal = true; });

    swVersion = 'uj-verzio'; // "kiadunk" egy új verziót
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
    await page.locator('#update-banner').waitFor({ state: 'visible', timeout: 10000 });
    expect((await text(page, 'update-text')).includes('a teszt után'), `teszt közben: ${await text(page, 'update-text')}`);
    await page.waitForTimeout(7000);
    expect(await page.evaluate(() => window.regiOldal === true), 'teszt közben újratöltött');

    await page.locator('.tab-btn').first().click(); // kilépés a tesztből a beállításokhoz
    expect((await text(page, 'update-text')).includes('mp múlva'), `a teszt után: ${await text(page, 'update-text')}`);
    await page.locator('#toast').waitFor({ state: 'visible', timeout: 15000 });
    expect(await page.evaluate(() => window.regiOldal === undefined), 'nem töltődött újra');
    expect((await text(page, 'toast')).includes('frissült'), `üzenet: ${await text(page, 'toast')}`);
    const keys = await page.evaluate(() => caches.keys());
    expect(keys.includes('szorzotabla-uj-verzio') && !keys.includes('szorzotabla-dev'), `gyorsítótárak: ${keys.join(', ')}`);
    const kept = await page.evaluate(() => ({ tables: selectedTables.join(), ops: currentOps.join(),
      buttons: [...document.querySelectorAll('#table-picker .btn-op.selected')].map((b) => b.dataset.op).join() }));
    expect(kept.tables === '2' && kept.ops === 'mul,div' && kept.buttons === 'mul,div', `a beállítások nem maradtak meg: ${JSON.stringify(kept)}`);
    swVersion = null;
    return page;
  });

  const viewports = [
    { width: 360, height: 740, n: 'telefon' }, { width: 412, height: 915, n: 'telefon-nagy' },
    { width: 768, height: 1024, n: 'tablet' }, { width: 1024, height: 768, n: 'tablet-fekvo' },
    { width: 1280, height: 800, n: 'laptop' },
  ];
  for (const vp of viewports) {
    await test(`Elrendezés: ${vp.n} ${vp.width}×${vp.height}`, async (expect) => {
      const page = await newPage({ viewport: { width: vp.width, height: vp.height } });
      const noHScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
      expect(await noHScroll(), 'vízszintes görgetősáv a beállításoknál');
      const opsFit = await page.evaluate(() => [...document.querySelectorAll('#table-picker .btn-op')]
        .every((b) => b.scrollWidth <= b.clientWidth + 1));
      expect(opsFit, 'a műveletgombok felirata kilóg');
      const head = await page.evaluate(() => {
        const r = (el) => el.getBoundingClientRect();
        const bar = r(document.querySelector('.tab-bar')), theme = r(document.getElementById('theme-btn'));
        const sound = r(document.getElementById('sound-btn'));
        const tabsFit = [...document.querySelectorAll('.tab-btn')].every((b) => b.scrollWidth <= b.clientWidth + 1);
        return { gap: Math.round(theme.left - bar.right), overlap: theme.right > sound.left, tabsFit };
      });
      expect(head.gap >= 0 && !head.overlap && head.tabsFit, `a fejlécben ütközik valami: ${JSON.stringify(head)}`);
      if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${vp.n}-1-beallitas.png`), fullPage: true });
      await pickTables(page, [8]);
      await start(page);
      const q = await question(page);
      await answer(page, q.ans + 1); // csontos üzenet
      const fb = await page.evaluate(() => { const f = document.getElementById('feedback'); return { sh: f.scrollHeight, ch: f.clientHeight }; });
      expect(fb.sh <= fb.ch + 1, `a visszajelzés szövege kilóg a dobozából (${fb.sh}px > ${fb.ch}px)`);
      expect(await noHScroll(), 'vízszintes görgetősáv a feladatnál');
      const padBottom = await page.evaluate(() => document.querySelector('.numpad').getBoundingClientRect().bottom);
      expect(padBottom <= vp.height, `a számbillentyűzet alja nem fér ki görgetés nélkül (${Math.round(padBottom)} > ${vp.height})`);
      if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${vp.n}-2-feladat.png`) });
      await answer(page, q.ans + 2); // végleges hiba: a levezetés a számbillentyűzet helyén
      const nextBottom = await page.evaluate(() => Math.round(document.getElementById('explain-next').getBoundingClientRect().bottom));
      expect(nextBottom <= vp.height, `a levezetés "Tovább" gombja nem fér ki görgetés nélkül (${nextBottom} > ${vp.height})`);
      expect(await noHScroll(), 'vízszintes görgetősáv a levezetésnél');
      if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${vp.n}-2b-levezetes.png`) });
      await tick(page);
      await page.locator('#explain-next').click();
      await playQuiz(page, (i) => (i % 3 === 0 ? 'wrong' : 'ok'));
      if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${vp.n}-3-eredmeny.png`), fullPage: true });
      await page.locator('.tab-btn').nth(1).click();
      await tick(page, 1500);
      expect(await noHScroll(), 'vízszintes görgetősáv a statisztikánál');
      await page.locator('#heatmap .hm-cell:not(.hm-none):not(.hm-head)').first().click();
      const fit = await page.evaluate(() => {
        const s = document.getElementById('screen-stats'), d = document.getElementById('hm-detail');
        const bottom = (sel) => Math.round(document.querySelector(sel).getBoundingClientRect().bottom);
        return { pageH: document.documentElement.scrollHeight, screenSh: s.scrollHeight, screenCh: s.clientHeight,
          grid: bottom('#heatmap'), clear: bottom('.btn-clear'), detailSh: d.scrollHeight, detailCh: d.clientHeight,
          cell: Math.round(document.querySelector('#heatmap .hm-cell').getBoundingClientRect().width) };
      });
      expect(fit.pageH <= vp.height && fit.screenSh <= fit.screenCh + 1 && fit.clear <= vp.height,
        `a Fejlődés fül nem fér ki (oldal ${fit.pageH}px, tartalom ${fit.screenSh}/${fit.screenCh}px, törlés gomb alja ${fit.clear}px, képernyő ${vp.height}px)`);
      expect(fit.cell >= 17, `túl kicsik a térkép mezői: ${fit.cell}px`);
      expect(fit.detailSh <= fit.detailCh + 1, `a mező részletei kilógnak (${fit.detailSh} > ${fit.detailCh}px)`);
      if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${vp.n}-4-statisztika.png`) });

      // Maradékos osztás: két mező és a tipp mellett is kifér a számbillentyűzet
      await page.locator('.tab-btn').first().click();
      await pickOps(page, 'Maradékos osztás');
      await start(page);
      const rq = await question(page);
      await answer(page, rq.ans + 1, 1, rq.rem);
      const remPad = await page.evaluate(() => Math.round(document.querySelector('.numpad').getBoundingClientRect().bottom));
      expect(remPad <= vp.height, `maradékos osztásnál a számbillentyűzet alja nem fér ki (${remPad} > ${vp.height})`);
      expect(await noHScroll(), 'vízszintes görgetősáv a maradékos osztásnál');
      if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${vp.n}-5-maradekos.png`) });
      return page;
    });
  }

  const hasSW = remoteUrl ? true : fs.existsSync(path.join(root, 'sw.js'));
  await test('Telepíthető app + teljesen offline (service worker)', async (expect) => {
    if (!hasSW) { expect(false, 'nincs service worker / manifest, hálózat nélkül nem indul'); return null; }
    const page = await newPage({ clock: false });
    const man = await page.evaluate(async () => {
      const href = document.querySelector('link[rel=manifest]')?.href;
      return href ? (await fetch(href)).json() : null;
    });
    expect(man?.icons?.some((i) => i.sizes === '512x512'), 'manifest / 512px ikon hiányzik');
    const swOk = await page.evaluate(async () => !!(await Promise.race([
      navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 10000))])));
    expect(swOk, 'a service worker nem indult el');
    await page.reload({ waitUntil: 'load' });
    await page.context().setOffline(true);
    await page.reload({ waitUntil: 'load' });
    expect((await page.title()).includes('Szorzótábla'), 'hálózat nélkül nem töltődött be');
    await page.clock.install();
    await pickTables(page, [9]);
    await page.locator('.btn-count', { hasText: '10 db' }).click();
    await start(page);
    await playQuiz(page);
    expect((await screen(page)) === 'screen-results', 'offline teszt nem ért végig');
    await page.locator('.tab-btn').nth(1).click();
    await tick(page, 1500);
    expect(await page.evaluate(() => !!chartInstance), 'offline nincs grafikon');
    return page;
  });

  await browser.close();
  srv?.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} teszt rendben.`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(2); });
