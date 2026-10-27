// Felhő (Supabase) teszt a "matek-gyakorlo-teszt" projekten: meghívás, belépés, gyerek, eszköz-kód,
// szinkron és jogosultságok. Az éles projekthez nem nyúl.
// Kell hozzá: SUPABASE_ACCESS_TOKEN (az adatbázis alaphelyzetbe állítása) és SUPABASE_SECRET_KEY_TEST.
// Futtatás: node tests/cloud.test.mjs [--shots <mappa>]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { readEnv, sql, PROJECTS } from '../scripts/supabase.mjs';

const args = process.argv.slice(2);
const shotsDir = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4173; // a teszt projektben ez a cím van engedélyezve a belépő linkekhez
const BASE = `http://127.0.0.1:${PORT}/`;
const SUPA = `https://${PROJECTS.test.ref}.supabase.co`;
const PUBLISHABLE = PROJECTS.test.key;
const SECRET = readEnv('SUPABASE_SECRET_KEY_TEST');

if (!SECRET || !readEnv('SUPABASE_ACCESS_TOKEN')) {
    console.log('Kihagyva: hiányzik a SUPABASE_SECRET_KEY_TEST vagy a SUPABASE_ACCESS_TOKEN (scripts/titkok-beallitasa.cmd).');
    process.exit(0);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
    '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

// A projekt mappáját szolgálja ki; a config.js helyett a teszt projekt adatait adja
function serve() {
    const srv = http.createServer((req, res) => {
        let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        if (p === '/') p = '/szorzotabla.html';
        if (p === '/config.js') {
            res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-cache' });
            return res.end(`const CLOUD_CONFIG = { url: '${SUPA}', key: '${PUBLISHABLE}' };`);
        }
        const f = path.join(root, p);
        if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' });
        fs.createReadStream(f).pipe(res);
    });
    return new Promise((ok) => srv.listen(PORT, '127.0.0.1', () => ok(srv)));
}

// --- Supabase segédek (admin = secret kulcs, csak Node-ból) ---
async function call(method, url, { token, key = PUBLISHABLE, body, prefer } = {}) {
    const headers = { apikey: key, 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (prefer) headers.Prefer = prefer;
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, ok: res.ok, data };
}
const admin = (method, p, body) => call(method, `${SUPA}/auth/v1/admin${p}`, { key: SECRET, token: SECRET, body });
const rest = (method, p, token, body, prefer) => call(method, `${SUPA}/rest/v1/${p}`, { token, body, prefer });
const rpc = (fn, token, body = {}) => rest('POST', `rpc/${fn}`, token, body);

async function resetDatabase() {
    const { data } = await admin('GET', '/users?per_page=1000');
    for (const u of (data && data.users) || []) await admin('DELETE', `/users/${u.id}`);
    await sql('test', 'truncate public.invitations, public.groups, public.children, public.device_code_attempts cascade;');
    await sql('test', 'update public.app_settings set teachers_enabled = false;'); // alapállapot: tanári funkciók kikapcsolva
}

const invite = (email, extra = '') => sql('test',
    `insert into public.invitations (email, can_create_groups, make_admin) values ('${email}', true, ${extra === 'admin'});`);

// Belépő link a felnőttnek (mintha a levélből kattintana); a felhasználót előbb létrehozza (a hook itt is szűr)
async function magicLink(email) {
    const created = await admin('POST', '/users', { email, email_confirm: true });
    if (!created.ok && created.status !== 422) throw new Error(`felhasználó létrehozás: ${created.status} ${JSON.stringify(created.data)}`);
    const link = await admin('POST', '/generate_link', { type: 'magiclink', email, redirect_to: `${BASE}szulo.html` });
    if (!link.ok) throw new Error(`belépő link: ${link.status} ${JSON.stringify(link.data)}`);
    return link.data;
}

// Valódi munkamenet (access token) egy felnőttnek, böngésző nélkül
async function tokenFor(email) {
    const link = await magicLink(email);
    const verified = await call('POST', `${SUPA}/auth/v1/verify`, { body: { type: 'magiclink', token_hash: link.hashed_token } });
    if (!verified.ok) throw new Error(`verify: ${verified.status} ${JSON.stringify(verified.data)}`);
    return verified.data.access_token;
}

// --- Tesztkeret ---
const results = [];
async function test(name, fn) {
    const checks = [];
    const expect = (ok, msg) => checks.push({ ok: !!ok, msg });
    try {
        await fn(expect);
    } catch (e) {
        // az első sorok: a hiba és hogy melyik elemre várt
        checks.push({ ok: false, msg: `kivétel: ${e.message.split('\n').filter((l) => l.trim()).slice(0, 3).join(' | ')}` });
    }
    const ok = checks.every((c) => c.ok);
    results.push(ok);
    console.log(`${ok ? 'OK  ' : 'HIBA'}  ${name}`);
    checks.filter((c) => !c.ok).forEach((c) => console.log(`        - ${c.msg}`));
    return ok;
}

async function newContext(browser) {
    const context = await browser.newContext({ viewport: { width: 900, height: 1100 } });
    const page = await context.newPage();
    page.errors = [];
    page.on('pageerror', (e) => page.errors.push(e.message));
    page.logs = [];
    page.on('console', (m) => { if (['warning', 'error'].includes(m.type())) page.logs.push(m.text()); });
    page.on('dialog', (d) => d.accept());
    await page.addInitScript(() => { if (!localStorage.getItem('szorzo_sound')) localStorage.setItem('szorzo_sound', '0'); });
    return page;
}

// A szülői felület beállításai összecsukott <details> elemekben vannak: kinyitja a beállítást
// (és ami körülötte van) a summary szövege alapján. Kattintással ellentétben nem csukja be, ha már nyitva van.
// Csak a látható nézetben keres: visszalépéskor a kezdőlap még a régi kártyákkal, rejtve várhat az újrarajzolásra.
async function openSetting(scope, text) {
    const summaries = scope.locator('summary', { hasText: text });
    for (let i = 0; i < 50; i++) {
        const opened = await summaries.evaluateAll((list) => {
            const s = list.find((x) => !x.closest('[hidden]'));
            if (!s) return false;
            for (let d = s.parentElement; d; d = d.parentElement) if (d.tagName === 'DETAILS') d.open = true;
            return true;
        });
        if (opened) return;
        await summaries.page().waitForTimeout(200);
    }
    throw new Error(`nincs ilyen beállítás a látható nézetben: ${text}`);
}

// Kinyitja a beállítást, és kattint benne; ha a lista közben újrarajzolódott (összecsukva), újra kinyitja
async function clickInSetting(scope, text, target) {
    for (let i = 0; ; i++) {
        await openSetting(scope, text);
        try {
            return await target.click({ timeout: 1000 });
        } catch (e) {
            if (i === 9) throw e;
        }
    }
}

async function playExam(page, table, wrongFirst = 0) {
    await page.locator('#mode-exam').click();
    await page.evaluate(() => { selectedTables = []; renderTableSelector(); }); // csak az adott tábla legyen kijelölve
    await page.locator('#tables-grid button').nth(table).click();
    await page.locator('#screen-setup .btn-start').click();
    await answerUntilResults(page, wrongFirst);
}

// Végigválaszolja a futó tesztet (az első wrongFirst feladatot rosszul), aztán vissza a beállításokhoz.
// Maradékos osztásnál az első OK a maradék mezőjére visz.
async function answerUntilResults(page, wrongFirst = 0, restart = true) {
    const type = async (n) => { for (const d of String(n)) await page.getByRole('button', { name: d, exact: true }).click(); };
    for (let i = 0; i < 40 && await page.locator('#screen-quiz.active').count(); i++) {
        const q = await page.evaluate(() => { const q = quizDeck[currentQuestionIndex]; return { ans: q.target, rem: q.rem ?? null }; });
        await type(i < wrongFirst ? q.ans + 1 : q.ans);
        if (q.rem !== null) {
            await page.locator('.action-submit').click();
            await type(q.rem);
        }
        await page.locator('.action-submit').click();
        await page.waitForTimeout(i < wrongFirst ? 1700 : 800);
    }
    await page.locator('#screen-results.active').waitFor({ timeout: 5000 });
    if (restart) await page.locator('#screen-results .btn-start').click();
}

async function main() {
    const srv = await serve();
    const browser = await chromium.launch({ channel: process.env.BROWSER || 'chrome' });
    console.log(`Felhő teszt: ${SUPA} (teszt projekt), app: ${BASE}\n`);
    await resetDatabase();
    await invite('admin@teszt.matek', 'admin');

    const parent = await newContext(browser);
    const kid = await newContext(browser);
    const shot = (page, name) => shotsDir && page.screenshot({ path: path.join(shotsDir, `felho-${name}.png`), fullPage: true });
    let code = null;

    await test('Admin belépés belépő linkkel, család és gyerek létrehozása, eszköz-kód', async (expect) => {
        const link = await magicLink('admin@teszt.matek');
        await parent.goto(link.action_link);
        await parent.locator('#view-home').waitFor({ state: 'visible', timeout: 20000 });
        expect((await parent.locator('#who-email').innerText()) === 'admin@teszt.matek', 'nem az admin lépett be');
        expect(await parent.locator('#mode-tabs [data-mode="admin"]').isVisible(), 'az admin fül hiányzik');
        const adminRoles = await parent.locator('#who-roles').innerText();
        expect(adminRoles.includes('Admin') && adminRoles.includes('Szülő'), `az admin jogosultságai a fejlécben: ${adminRoles}`);
        await parent.fill('#group-name', 'Teszt család');
        await parent.locator('#new-group-card .btn').click();
        await parent.locator('.card h2', { hasText: 'Teszt család' }).waitFor();
        await openSetting(parent, 'Gyerek hozzáadása');
        await parent.locator('.add-child-box .avatars button', { hasText: '🐼' }).first().click();
        await parent.fill('.add-child input[name=nickname]', 'Bori');
        await parent.locator('.add-child .btn').click();
        await parent.locator('.child-btn', { hasText: 'Bori' }).click();
        await parent.locator('#view-child').waitFor({ state: 'visible' });
        await openSetting(parent, 'Eszközök');
        await parent.locator('button', { hasText: 'Új eszköz-kód' }).click();
        await parent.locator('#code-box').waitFor({ state: 'visible', timeout: 10000 });
        code = (await parent.locator('#code-value').innerText()).trim();
        expect(/^[A-Z2-9]{6}$/.test(code), `kód: ${code}`);
        const height = await parent.evaluate(() => document.documentElement.scrollHeight);
        expect(height < 3000, `az oldal túl magas: ${height}px (elszabadult a grafikon?)`);
        await shot(parent, '1-gyerek');
        expect(!parent.errors.length, `JS hiba: ${parent.errors.join(' | ')}`);
    });

    await test('Gyerek eszköze: helyi eredmény, összekötés kóddal, átvétel és szinkron', async (expect) => {
        await kid.goto(BASE);
        await playExam(kid, 2); // 11 helyes feladat még összekötés előtt
        await kid.locator('#cloud-footer-btn').click();
        expect(await kid.locator('#cloud-import-row').isVisible(), 'az átvétel kérdése nem látszik, pedig van helyi eredmény');
        await kid.fill('#cloud-code', code);
        await kid.locator('#cloud-link-btn').click();
        await kid.locator('#child-chip').waitFor({ state: 'visible', timeout: 20000 });
        expect((await kid.locator('#child-chip').innerText()).includes('🐼 Bori'), 'a jelvény nem Borié');
        await playExam(kid, 3, 2); // 2 hibával
        await kid.waitForFunction(() => {
            const box = JSON.parse(localStorage.getItem('szorzo_outbox') || '{"answers":[1]}');
            return !box.answers.length && !box.sessions.length;
        }, null, { timeout: 20000 });
        const counts = await sql('test', `select (select count(*) from public.answers) a, (select count(*) from public.answers where imported) i,
            (select count(*) from public.quiz_sessions) s, (select count(*) from public.answers where outcome = 'x') x`);
        const c = counts[0];
        expect(+c.a === 22 && +c.i === 11 && +c.s === 2 && +c.x === 2, `a felhőben: ${JSON.stringify(c)} (22 válasz, 11 átvett, 2 teszt, 2 hiba kell)`);
        const facts = await kid.evaluate(() => JSON.parse(localStorage.getItem('szorzo_facts') || '{}'));
        expect(Object.keys(facts).length === 22, `a helyi térkép a felhőből: ${Object.keys(facts).length} feladat (22 kell)`);
        await shot(kid, '2-gyerek-app');
        expect(!kid.errors.length, `JS hiba: ${kid.errors.join(' | ')}`);
    });

    await test('Szülő látja a gyerek statisztikáját és az eszközt', async (expect) => {
        await parent.locator('button:visible', { hasText: 'Vissza a csoportokhoz' }).click();
        await parent.locator('.child-btn', { hasText: 'Bori' }).click();
        await parent.locator('#view-child').waitFor({ state: 'visible' });
        const summary = await parent.locator('#child-summary').innerText();
        expect(summary.includes('2 teszt') && summary.includes('22 megválaszolt'), `összegzés: ${summary}`);
        const colored = await parent.locator('#child-heatmap .hm-cell:not(.hm-none):not(.hm-head)').count();
        expect(colored === 22, `színes mezők a térképen: ${colored} (22 kell)`);
        expect((await parent.locator('#device-list li').count()) === 1, 'az összekötött eszköz nem látszik');
        await shot(parent, '3-statisztika');
    });

    await test('Közös tablet: második gyerek, "Ki gyakorol most?", gyerek-PIN', async (expect) => {
        // A szülő Borinak PIN-t ad, és felveszi Petit
        await openSetting(parent, 'Gyerek-PIN');
        await parent.fill('#child-pin', '1234');
        await parent.locator('button', { hasText: 'PIN beállítása' }).click();
        await parent.locator('#pin-status', { hasText: 'Be van kapcsolva' }).waitFor({ timeout: 10000 });
        await parent.locator('button:visible', { hasText: 'Vissza a csoportokhoz' }).click();
        await openSetting(parent, 'Gyerek hozzáadása');
        await parent.locator('.add-child-box .avatars button', { hasText: '🐯' }).first().click();
        await parent.fill('.add-child input[name=nickname]', 'Peti');
        await parent.locator('.add-child .btn').click();
        await parent.locator('.child-btn', { hasText: 'Peti' }).click();
        await parent.locator('#view-child').waitFor({ state: 'visible' });
        await openSetting(parent, 'Eszközök');
        await parent.locator('button', { hasText: 'Új eszköz-kód' }).click();
        await parent.locator('#code-box').waitFor({ state: 'visible', timeout: 10000 });
        const petiCode = (await parent.locator('#code-value').innerText()).trim();

        // Ugyanazon a tableten Peti is összekötődik, és gyakorol
        await kid.locator('#cloud-footer-btn').click();
        await kid.locator('#cloud-add-btn').click();
        await kid.fill('#cloud-code', petiCode);
        await kid.locator('#cloud-link-btn').click();
        await kid.locator('#child-chip', { hasText: 'Peti' }).waitFor({ timeout: 20000 });
        expect((await kid.locator('#child-chip').innerText()).includes('⇄'), 'a jelvényen nem látszik, hogy lehet váltani');
        await playExam(kid, 5);
        await kid.waitForFunction(() => {
            const box = JSON.parse(localStorage.getItem('szorzo_outbox') || '{"answers":[1]}');
            return !box.answers.length && !box.sessions.length;
        }, null, { timeout: 20000 });
        const perChild = await sql('test', `select c.nickname, count(a.id) as n from public.children c
            left join public.answers a on a.child_id = c.id group by c.nickname`);
        const counts = Object.fromEntries(perChild.map((r) => [r.nickname, +r.n]));
        expect(counts.Bori === 22 && counts.Peti === 11, `válaszok gyerekenként: ${JSON.stringify(counts)} (Bori 22, Peti 11 kell)`);

        // Az app újraindul: ki gyakorol most? Bori a PIN-jével
        const restarted = await kid.context().newPage();
        restarted.on('dialog', (d) => d.accept());
        await restarted.goto(BASE);
        await restarted.waitForFunction(() => JSON.parse(localStorage.getItem('szorzo_children') || '[]').some((c) => c.pin_hash),
            null, { timeout: 20000 });
        await restarted.locator('#profile-overlay').waitFor({ state: 'visible', timeout: 10000 });
        expect((await restarted.locator('.profile-btn').count()) === 2, 'nem két profil közül lehet választani');
        await restarted.locator('.profile-btn', { hasText: 'Bori' }).click();
        await restarted.locator('#pin-overlay').waitFor({ state: 'visible' });
        const tapPin = async (digits) => {
            for (const d of digits) await restarted.locator('#pin-overlay').getByRole('button', { name: d, exact: true }).click();
            await restarted.waitForTimeout(500);
        };
        await tapPin('0000');
        const wrong = await restarted.locator('#pin-msg').innerText();
        expect(wrong.includes('Nem ez'), `rossz PIN után: ${wrong}`);
        await tapPin('1234');
        await restarted.locator('#child-chip', { hasText: 'Bori' }).waitFor({ timeout: 10000 });
        const facts = await restarted.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('szorzo_facts') || '{}')).length);
        expect(facts === 22, `Bori térképe: ${facts} feladat (22 kell, nem Petié)`);
        await shot(restarted, '4-kozos-tablet');
        await restarted.close();
    });

    await test('Meghívás az appból: a meghívott belép és látja a családot', async (expect) => {
        // a teszt projekt nem küld levelet: a levélküldést itt "elfogjuk"
        await parent.route('**/auth/v1/otp**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
        await parent.locator('button:visible', { hasText: 'Vissza a csoportokhoz' }).click();
        await openSetting(parent, 'Családtagok (');
        await parent.fill('.invite input[name=email]', 'masik@teszt.matek');
        await parent.locator('.invite .btn').click();
        await parent.locator('.msg.ok', { hasText: 'Meghívó elküldve' }).waitFor({ timeout: 10000 });
        await parent.locator('#pending-list', { hasText: 'masik@teszt.matek' }).waitFor({ state: 'attached', timeout: 10000 });

        const other = await newContext(browser);
        await other.goto((await magicLink('masik@teszt.matek')).action_link);
        await other.locator('#view-home').waitFor({ state: 'visible', timeout: 20000 });
        expect(await other.locator('.child-btn', { hasText: 'Bori' }).isVisible(), 'a meghívott nem látja Borit');
        expect(!(await other.locator('#new-group-card').isVisible()), 'a tag nem hozhatna létre csoportot');
        await other.context().close();
    });

    await test('Jogosultság: idegen felnőtt nem lát semmit, meghívó nélkül nincs regisztráció', async (expect) => {
        // A valódi út: belépő link kérése meghívó nélkül -> a regisztrációs hook elutasítja
        const nobody = await call('POST', `${SUPA}/auth/v1/otp`, { body: { email: 'nincs-meghivo@teszt.matek', create_user: true } });
        expect(!nobody.ok && JSON.stringify(nobody.data).includes('meghívó'),
            `meghívó nélküli belépő link: ${nobody.status} ${JSON.stringify(nobody.data)}`);
        const created = await sql('test', `select count(*) as n from auth.users where email = 'nincs-meghivo@teszt.matek'`);
        expect(+created[0].n === 0, 'meghívó nélkül létrejött a fiók');

        await invite('idegen@teszt.matek');
        const stranger = await tokenFor('idegen@teszt.matek');
        await rpc('accept_invitations', stranger);
        const children = await rest('GET', 'children?select=id', stranger);
        const answers = await rest('GET', 'answers?select=id&limit=5', stranger);
        expect(children.ok && children.data.length === 0, `idegen látja a gyerekeket: ${JSON.stringify(children.data)}`);
        expect(answers.ok && answers.data.length === 0, 'idegen látja a válaszokat');
        const bori = (await sql('test', `select id from public.children where nickname = 'Bori'`))[0].id;
        const facts = await rpc('child_facts', stranger, { p_child_id: bori });
        expect(facts.ok && facts.data.length === 0, 'idegen lekérte Bori statisztikáját');
        const code2 = await rpc('create_device_code', stranger, { p_child_id: bori });
        expect(!code2.ok, 'idegen kódot kért Borihoz');
        const write = await rest('POST', 'answers', stranger, [{ id: crypto.randomUUID(), child_id: bori, op: 'mul', tbl: 2,
            other: 3, outcome: 'o', answered_at: new Date().toISOString() }]);
        expect(!write.ok, 'idegen írt Bori válaszai közé');
        const anon = await rest('GET', 'children?select=id', null);
        expect(!anon.ok || anon.data.length === 0, 'bejelentkezés nélkül is látszanak a gyerekek');
    });

    await test('Eszköz-kód: találgatás ellen óránként 10 próbálkozás', async (expect) => {
        const anon = await call('POST', `${SUPA}/auth/v1/signup`, { body: { data: {} } });
        const token = anon.data && anon.data.access_token;
        expect(token, `névtelen belépés: ${anon.status}`);
        let last = null;
        for (let i = 0; i < 11; i++) last = await rpc('redeem_device_code', token, { p_code: 'AAAAAA' });
        expect(last.ok && String(last.data.error).includes('Túl sok'), `11. próbálkozás: ${JSON.stringify(last.data)}`);
        const own = await rest('GET', 'children?select=id', token);
        expect(own.ok && own.data.length === 0, 'kód nélküli eszköz lát gyereket');
    });

    await test('Leválasztott eszköz: nem írhat többé, és a gyerek appja is észreveszi', async (expect) => {
        await parent.locator('.child-btn', { hasText: 'Bori' }).click();
        await parent.locator('#view-child').waitFor({ state: 'visible' });
        await openSetting(parent, 'Eszközök');
        await parent.locator('#device-list button', { hasText: 'leválasztás' }).click();
        await parent.locator('#device-list', { hasText: 'Még nincs összekötött eszköz' }).waitFor({ timeout: 10000 });
        kid.logs.length = 0;
        await kid.reload();
        try {
            await kid.locator('#child-chip', { hasText: 'Peti' }).waitFor({ timeout: 20000 });
        } catch (e) {
            const state = await kid.evaluate(() => ({
                children: localStorage.getItem('szorzo_children'), active: localStorage.getItem('szorzo_active_child'),
                chip: document.getElementById('child-chip').innerText, hidden: document.getElementById('child-chip').hidden }));
            throw new Error(`a jelvény nem Peti: ${JSON.stringify(state)} | napló: ${kid.logs.join(' | ')}`);
        }
        const left = await kid.evaluate(() => JSON.parse(localStorage.getItem('szorzo_children') || '[]').map((c) => c.nickname));
        expect(JSON.stringify(left) === '["Peti"]', `az eszközön maradt: ${JSON.stringify(left)} (csak Peti kell)`);
        const token = await kid.evaluate(() => JSON.parse(localStorage.getItem('szorzo-eszkoz-auth')).access_token);
        const bori = (await sql('test', `select id from public.children where nickname = 'Bori'`))[0].id;
        const write = await rest('POST', 'answers', token, [{ id: crypto.randomUUID(), child_id: bori, op: 'mul', tbl: 2,
            other: 3, outcome: 'o', answered_at: new Date().toISOString(), device_user_id: null }]);
        expect(!write.ok, 'a leválasztott eszköz még írhat Bori válaszai közé');
    });

    const adultToken = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('szorzo-felnott-auth')).access_token);
    // Szülő / tanár / admin fül a szülői felületen
    const mode = async (page, m) => {
        await page.locator('button:visible', { hasText: 'Vissza a csoportokhoz' }).click().catch(() => {});
        await page.locator(`#mode-tabs [data-mode="${m}"]`).click();
    };
    const familyId = async () => (await sql('test', `select id from public.groups where name = 'Teszt család'`))[0].id;
    const childId = async (name) => (await sql('test', `select id from public.children where nickname = '${name}'`))[0].id;

    await test('Osztály: csatlakozási kód, a tanár látja a gyereket, a szülő kiveheti, admin megvonja a hozzáférést', async (expect) => {
        // Az admin meghív egy tanárt, aki saját csoportot hozhat létre
        await parent.route('**/auth/v1/otp**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
        await parent.locator('button:visible', { hasText: 'Vissza a csoportokhoz' }).click().catch(() => {});
        await parent.locator('#view-home').waitFor({ state: 'visible' });
        await mode(parent, 'admin');
        expect((await parent.locator('#console-title').innerText()).includes('Admin'), 'az admin fül címe');

        // A tanári funkciók alapból ki vannak kapcsolva: tanárt meghívni és osztályt létrehozni sem lehet (az admin sem)
        expect(!(await parent.locator('#teachers-enabled').isChecked()) && await parent.locator('#creator-class-row').isHidden(),
            'kikapcsolt tanári funkcióknál is látszik a tanár meghívása');
        const adminToken = await adultToken(parent);
        const classOff = await rpc('create_group', adminToken, { p_name: 'Tiltott osztály', p_kind: 'class' });
        const inviteOff = await rpc('admin_invite', adminToken, { p_email: 'tiltott@teszt.matek', p_families: false, p_classes: true });
        expect(!classOff.ok && !inviteOff.ok, `kikapcsolva: osztály ${classOff.status}, tanár-meghívó ${inviteOff.status} (mindkettő tiltott)`);
        const settingsByKid = await rest('GET', 'app_settings?select=teachers_enabled',
            await kid.evaluate(() => JSON.parse(localStorage.getItem('szorzo-eszkoz-auth')).access_token));
        expect(JSON.stringify(settingsByKid.data) === '[]', `a gyerek eszköze is látja a beállításokat: ${JSON.stringify(settingsByKid.data)}`);
        await parent.locator('#teachers-enabled').check();
        await parent.locator('#creator-class-row').waitFor({ state: 'visible', timeout: 10000 });

        await parent.fill('#creator-email', 'tanar@teszt.matek');
        await parent.locator('#creator-family').uncheck(); // csak tanár
        await parent.locator('#creator-class').check();
        await parent.locator('#admin-card .btn', { hasText: 'Meghívás' }).click();
        await parent.locator('#creator-msg.ok').waitFor({ timeout: 10000 });
        await mode(parent, 'family');
        expect((await parent.locator('#console-title').innerText()).includes('Szülői felület'), 'a szülő fül címe');

        const teacher = await newContext(browser);
        await teacher.goto((await magicLink('tanar@teszt.matek')).action_link);
        await teacher.locator('#view-home').waitFor({ state: 'visible', timeout: 20000 });
        const teacherRoles = await teacher.locator('#who-roles').innerText();
        expect(teacherRoles.includes('Tanár') && !teacherRoles.includes('Admin') && !teacherRoles.includes('Szülő'),
            `a tanár jogosultságai a fejlécben: ${teacherRoles} (csak Tanár kell)`);
        const teacherFamily = await rpc('create_group', await adultToken(teacher), { p_name: 'Kamu család', p_kind: 'family' });
        expect(!teacherFamily.ok, 'a csak tanárként meghívott családot hozhatott létre');
        await mode(teacher, 'class');
        expect((await teacher.locator('#console-title').innerText()).includes('Tanári felület'), 'a tanár fül címe');
        await teacher.fill('#group-name', '3.b');
        await teacher.locator('#new-group-card .btn').click();
        await teacher.locator('.card h2', { hasText: '3.b' }).waitFor();
        await openSetting(teacher, 'Csatlakozási kód');
        await teacher.locator('[data-act="joincode"]').click();
        await teacher.locator('.join-box').waitFor({ state: 'visible', timeout: 10000 });
        const joinCode = (await teacher.locator('.join-box .code').innerText()).trim();
        expect(/^[A-Z2-9]{6}$/.test(joinCode), `csatlakozási kód: ${joinCode}`);

        // A szülő beteszi Borit az osztályba
        await parent.locator('.child-btn', { hasText: 'Bori' }).first().click();
        await parent.locator('#view-child').waitFor({ state: 'visible' });
        await openSetting(parent, 'Csatlakozás osztályhoz');
        await parent.fill('#join-code', joinCode);
        await parent.locator('#view-child').getByRole('button', { name: 'Csatlakozás', exact: true }).click();
        await parent.locator('#child-group-list', { hasText: '3.b' }).waitFor({ state: 'attached', timeout: 10000 });

        // A tanár látja Borit és a statisztikáját, de a családot nem, és onnan nem veheti ki
        await teacher.reload();
        await teacher.locator('.child-btn', { hasText: 'Bori' }).click();
        await teacher.locator('#view-child').waitFor({ state: 'visible' });
        const colored = await teacher.locator('#child-heatmap .hm-cell:not(.hm-none):not(.hm-head)').count();
        expect(colored === 22, `a tanár Bori térképén ${colored} színes mező (22 kell)`);
        const groupList = await teacher.locator('#child-group-list').textContent(); // összecsukott beállításban van
        expect(groupList.includes('egy másik család') && !groupList.includes('Teszt család'), `a tanárnak látszó csoportok: ${groupList}`);
        const familyRemove = await rpc('remove_child_from_group', await adultToken(teacher),
            { p_child_id: await childId('Bori'), p_group_id: await familyId() });
        expect(!familyRemove.ok, 'a tanár kivehette a gyereket a családból');
        // "A család az első": a tanár nem kér eszköz-kódot, nem töröl, és a felületen nem is látja ezeket
        const teacherToken = await adultToken(teacher);
        const teacherCode = await rpc('create_device_code', teacherToken, { p_child_id: await childId('Bori') });
        expect(!teacherCode.ok, 'a tanár eszköz-kódot kérhetett a családi gyereknek');
        await rest('DELETE', `children?id=eq.${await childId('Bori')}`, teacherToken);
        expect((await sql('test', `select count(*) as n from public.children where nickname = 'Bori'`))[0].n == 1, 'a tanár törölhette a családi gyereket');
        expect(await teacher.locator('#child-devices-card').isHidden() && await teacher.locator('#delete-child-btn').isHidden(),
            'a tanárnak látszanak a család eszközei / a törlés gomb');
        const children = await rest('GET', 'children?select=nickname', await adultToken(teacher));
        expect(JSON.stringify(children.data) === '[{"nickname":"Bori"}]', `a tanár ezeket a gyerekeket látja: ${JSON.stringify(children.data)}`);

        // Csatlakozási kód családhoz nem kérhető
        const familyCode = await rpc('create_group_join_code', await adultToken(parent), { p_group_id: await familyId() });
        expect(!familyCode.ok, 'családhoz is lehetett csatlakozási kódot kérni');

        // A tanár meghív egy szülőt: családot hozhat létre, osztályt nem
        await teacher.route('**/auth/v1/otp**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
        await teacher.locator('button:visible', { hasText: 'Vissza a csoportokhoz' }).click();
        await openSetting(teacher, 'Szülő meghívása');
        await teacher.fill('.invite-parent input[name=email]', 'szulo2@teszt.matek');
        await teacher.locator('.invite-parent .btn').click();
        await teacher.locator('.invite-parent + .msg.ok').waitFor({ timeout: 10000 });
        const parent2 = await tokenFor('szulo2@teszt.matek');
        await rpc('accept_invitations', parent2);
        const familyOk = await rpc('create_group', parent2, { p_name: 'Szülő2 család', p_kind: 'family' });
        const classNo = await rpc('create_group', parent2, { p_name: 'Kamu osztály', p_kind: 'class' });
        expect(familyOk.ok && !classNo.ok, `a tanártól meghívott szülő: család ${familyOk.status}, osztály ${classNo.status} (család igen, osztály nem)`);

        // Peti is bekerül az osztályba; a tanár összesítést lát
        await parent.locator('button:visible', { hasText: 'Vissza a csoportokhoz' }).click();
        await parent.locator('.child-btn', { hasText: 'Peti' }).first().click();
        await parent.locator('#view-child').waitFor({ state: 'visible' });
        await openSetting(parent, 'Csatlakozás osztályhoz');
        await parent.fill('#join-code', joinCode);
        await parent.locator('#view-child').getByRole('button', { name: 'Csatlakozás', exact: true }).click();
        await parent.locator('#child-group-list', { hasText: '3.b' }).waitFor({ state: 'attached', timeout: 10000 });

        const classCard = () => teacher.locator('.card', { has: teacher.locator('h2', { hasText: '3.b' }) });
        await teacher.reload();
        await classCard().locator('[data-act="overview"]').click();
        await teacher.locator('#view-group').waitFor({ state: 'visible', timeout: 10000 });
        const groupColored = await teacher.locator('#group-heatmap .hm-cell:not(.hm-none):not(.hm-head)').count();
        expect(groupColored === 33, `az osztály térképén ${groupColored} színes mező (Bori 22 + Peti 11 = 33 kell)`);
        await teacher.locator('#group-heatmap .hm-cell.hm-l0').first().click();
        const groupDetail = await teacher.locator('#group-hm-detail').innerText();
        expect(groupDetail.includes('Gyakorolnia kell') && groupDetail.includes('Bori'), `összesítés részletei: ${groupDetail}`);
        const kidsList = await teacher.locator('#group-children').innerText();
        expect(kidsList.includes('Bori') && kidsList.includes('Peti'), `gyerekek a csoportban: ${kidsList}`);

        // Feladat kiosztása: 6-os tábla, 5 db, határidő 3 nap múlva
        await openSetting(teacher, 'Új feladat kiosztása');
        await teacher.locator('#assign-tables button', { hasText: '6-os' }).click();
        await teacher.fill('#assign-count', '5');
        await teacher.fill('#assign-due', new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10));
        await teacher.fill('#assign-note', 'Hajrá!');
        await teacher.locator('.assign-form .btn').click();
        await teacher.locator('#assignment-list .assignment', { hasText: '6-os tábla' }).waitFor({ timeout: 10000 });
        expect((await teacher.locator('#assignment-list').innerText()).includes('kész: 0/2'),
            `feladatlista: ${await teacher.locator('#assignment-list').innerText()}`);

        // Peti tabletjén megjelenik, megcsinálja, a kártya eltűnik, a tanárnál kész
        await kid.reload();
        await kid.locator('.assignment-card', { hasText: '6-os' }).waitFor({ timeout: 20000 });
        expect((await kid.locator('.assignment-card').innerText()).includes('Hajrá'), 'a feladat üzenete nem látszik');
        await shot(kid, '5-feladat-kartya');
        await kid.locator('.assignment-card button', { hasText: 'Indítás' }).click();
        const quizSize = await kid.evaluate(() => quizDeck.length);
        expect(quizSize === 5 && (await kid.evaluate(() => currentAssignmentId)), `a feladat teszt: ${quizSize} kérdés (5 kell)`);
        await answerUntilResults(kid);
        await kid.waitForFunction(() => !JSON.parse(localStorage.getItem('szorzo_outbox') || '{"sessions":[1]}').sessions.length,
            null, { timeout: 20000 });
        expect(!(await kid.locator('.assignment-card').count()), 'a kész feladat kártyája nem tűnt el');
        await teacher.reload();
        await classCard().locator('[data-act="overview"]').click();
        await teacher.locator('#assignment-list .done', { hasText: 'Peti' }).waitFor({ timeout: 10000 });
        expect((await teacher.locator('#assignment-list').innerText()).includes('kész: 1/2'),
            `feladatlista: ${await teacher.locator('#assignment-list').innerText()}`);
        await shot(teacher, '6-osztaly-osszesites');

        // A szülő kiveszi Borit az osztályból (Peti bent marad)
        await parent.locator('button:visible', { hasText: 'Vissza a csoportokhoz' }).click();
        await parent.locator('.child-btn', { hasText: 'Bori' }).first().click();
        await parent.locator('#view-child').waitFor({ state: 'visible' });
        await openSetting(parent, 'Csoportok');
        await parent.locator('#child-group-list li', { hasText: '3.b' }).locator('button', { hasText: 'kivétel' }).click();
        await parent.locator('#child-group-list', { hasText: '3.b' }).waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
        const left = await sql('test', `select string_agg(c.nickname, ',') as kids from public.child_groups cg
            join public.groups g on g.id = cg.group_id join public.children c on c.id = cg.child_id where g.name = '3.b'`);
        expect(left[0].kids === 'Peti', `az osztályban maradt: ${left[0].kids} (csak Peti kell)`);

        // Az admin megvonja a tanár hozzáférését: a fiók és a csak az övé lévő osztály törlődik
        await parent.locator('button:visible', { hasText: 'Vissza a csoportokhoz' }).click();
        await mode(parent, 'admin');
        await parent.locator('#admin-adults', { hasText: 'tanar@teszt.matek' }).waitFor({ timeout: 10000 });
        await clickInSetting(parent.locator('#admin-adults'), 'tanar@teszt.matek',
            parent.locator('#admin-adults .setting', { hasText: 'tanar@teszt.matek' }).locator('[data-revoke]'));
        await parent.locator('#admin-adults', { hasText: 'tanar@teszt.matek' }).waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
        const gone = await sql('test', `select (select count(*) from auth.users where email = 'tanar@teszt.matek') u,
            (select count(*) from public.groups where name = '3.b') g`);
        expect(+gone[0].u === 0 && +gone[0].g === 0, `a tanár után maradt: ${JSON.stringify(gone[0])}`);

        // Visszakapcsolás: a tanár szerep és az osztály-létrehozás megint tiltott
        await parent.locator('#teachers-enabled').uncheck();
        await parent.locator('#creator-class-row').waitFor({ state: 'hidden', timeout: 10000 });
        const classOffAgain = await rpc('create_group', await adultToken(parent), { p_name: 'Tiltott osztály', p_kind: 'class' });
        expect(!classOffAgain.ok, 'kikapcsolás után is lehetett osztályt létrehozni');
        expect(!teacher.errors.length && !parent.errors.length, `JS hiba: ${[...teacher.errors, ...parent.errors].join(' | ')}`);
        await teacher.context().close();
    });

    await test('Csillagok: cél, ajándék, egyéni feladat a gyerek tabletjén, beváltás, csillag mindenkinek', async (expect) => {
        await mode(parent, 'family');
        const peti = await childId('Peti');
        const stars = async (id) => +(await sql('test', `select coalesce(sum(stars), 0) as n from public.star_events('${id}')`))[0].n;
        const before = await stars(peti);
        // eddig: 5-ös tábla hibátlanul (1 + 1) és az osztály 6-os feladata (+2; az osztály törlése után is megmarad)
        expect(before === 4, `Peti csillagai a teszt elején: ${before} (4 kell)`);

        // A szülő célt tűz ki, csillagot ad, és csak Petinek oszt ki egy feladatot
        await parent.locator('.child-btn', { hasText: 'Peti' }).first().click();
        await parent.locator('#view-child').waitFor({ state: 'visible' });
        await openSetting(parent, 'Új cél kitűzése');
        await parent.locator('#goal-emojis button', { hasText: '🍦' }).click();
        await parent.fill('#goal-title', 'Fagyi');
        await parent.fill('#goal-target', '3');
        await parent.locator('#goal-box .btn').click();
        await parent.locator('#child-goals', { hasText: 'Fagyi' }).waitFor({ timeout: 10000 });
        await openSetting(parent, 'Csillag ajándékozása');
        await parent.locator('#grant-amount').selectOption('2');
        await parent.fill('#grant-note', 'Ügyes vagy!');
        await parent.locator('#grant-box .btn').click();
        await parent.locator('#child-stars-total', { hasText: String(before + 2) }).waitFor({ timeout: 10000 });
        await openSetting(parent, 'Új feladat kiosztása');
        await parent.locator('#assign-tables button', { hasText: '4-es' }).click();
        await parent.fill('#assign-count', '5');
        await parent.locator('.assign-form .btn').click();
        await parent.locator('#child-assignments', { hasText: 'csak neki' }).waitFor({ timeout: 10000 });
        const own = await sql('test', `select count(*) as n from public.assignments where child_id = '${peti}'`);
        expect(+own[0].n === 1, `Petinek szóló feladat: ${own[0].n}`);

        // A tableten: ajándék-értesítés, a cél és a feladat; a feladat után a cél is teljesül
        await kid.reload();
        await kid.locator('#star-overlay').waitFor({ state: 'visible', timeout: 20000 });
        const gift = await kid.locator('#star-overlay').innerText();
        expect(gift.includes('+2') && gift.includes('Ügyes vagy'), `ajándék értesítés: ${gift}`);
        await kid.locator('#star-overlay .btn-start').click();
        expect((await kid.locator('#stars-box').innerText()).includes('Fagyi'), 'a cél nem látszik a tableten');
        await kid.locator('.assignment-card', { hasText: '4-es' }).locator('button').click();
        await answerUntilResults(kid, 0, false);
        const earned = await kid.locator('#res-stars').innerText();
        expect(earned.includes('+2'), `csillag az eredménynél: ${earned} (+2 kell: 5 feladat, de kiosztott)`);
        await kid.locator('#star-overlay', { hasText: 'Fagyi' }).waitFor({ state: 'visible', timeout: 10000 });
        await shot(kid, '7-cel-teljesult');
        await kid.locator('#star-overlay .btn-start').click();
        await kid.locator('#screen-results .btn-start').click();
        await kid.waitForFunction(() => !JSON.parse(localStorage.getItem('szorzo_outbox') || '{"sessions":[1]}').sessions.length,
            null, { timeout: 20000 });
        const after = await stars(peti);
        expect(after === before + 4, `Peti csillagai: ${after} (${before + 4} kell: +2 ajándék, +2 feladat)`);
        await kid.locator('#stars-box', { hasText: String(after) }).waitFor({ timeout: 10000 });

        // A szülő beváltja a célt; a csoportnak is ad csillagot
        await parent.locator('button:visible', { hasText: 'Vissza a csoportokhoz' }).click();
        await parent.locator('.child-btn', { hasText: 'Peti' }).first().click();
        await parent.locator('#view-child').waitFor({ state: 'visible' });
        await parent.locator('#child-goals [data-redeem]').click();
        await parent.locator('#child-goals', { hasText: 'beváltva' }).waitFor({ timeout: 10000 });
        const redeemed = await sql('test', `select count(*) as n from public.star_goals where redeemed_at is not null`);
        expect(+redeemed[0].n === 1, 'a cél nincs beváltva');
        const progress = await rpc('assignment_progress', await adultToken(parent), { p_group_id: await familyId() });
        const ownId = (await sql('test', `select id from public.assignments where child_id = '${peti}'`))[0].id;
        const ownRows = (progress.data || []).filter((r) => r.assignment_id === ownId);
        expect(ownRows.length === 1 && ownRows[0].nickname === 'Peti' && ownRows[0].done === 1,
            `a Petinek szóló feladat haladása: ${JSON.stringify(ownRows)} (csak Peti, 1× kész)`);
        await parent.locator('button:visible', { hasText: 'Vissza a csoportokhoz' }).click();
        await parent.locator('.card', { has: parent.locator('h2', { hasText: 'Teszt család' }) }).locator('[data-act="overview"]').click();
        await parent.locator('#view-group').waitFor({ state: 'visible', timeout: 10000 });
        await openSetting(parent, 'Csillag mindenkinek');
        await parent.locator('#group-grant-box .btn').click();
        await parent.locator('#group-children', { hasText: `⭐ ${after + 3}` }).waitFor({ timeout: 10000 });
        const groupGrants = await sql('test', `select count(*) as n from public.star_grants where amount = 3`);
        expect(+groupGrants[0].n === 2, `csillag mindenkinek: ${groupGrants[0].n} sor (Bori és Peti)`);

        // Idegen nem adhat csillagot, a tablet sem írhat bele
        const stranger = await tokenFor('idegen@teszt.matek');
        const strangerGrant = await rpc('grant_stars', stranger, { p_child_id: peti, p_amount: 50, p_note: 'kamu' });
        expect(!strangerGrant.ok, 'idegen csillagot adott');
        const kidToken = await kid.evaluate(() => JSON.parse(localStorage.getItem('szorzo-eszkoz-auth')).access_token);
        const kidGrant = await rest('POST', 'star_grants', kidToken, [{ child_id: peti, amount: 50 }]);
        expect(!kidGrant.ok, 'a tablet maga írt csillagot');
        await shot(parent, '8-csoport-csillag');
        expect(!kid.errors.length && !parent.errors.length, `JS hiba: ${[...kid.errors, ...parent.errors].join(' | ')}`);
    });

    await test('Szerkesztés: gyerek átnevezése, szerep, utolsó tulajdonos, csoport törlése, saját fiók törlése', async (expect) => {
        await mode(parent, 'family');
        // Gyerek átnevezése és avatar csere
        await parent.locator('.child-btn', { hasText: 'Peti' }).first().click();
        await parent.locator('#view-child').waitFor({ state: 'visible' });
        await openSetting(parent, 'Név és avatar');
        await parent.fill('#edit-nickname', 'Petike');
        await parent.locator('#edit-avatars button', { hasText: '🦄' }).click();
        await parent.locator('#child-edit-box button', { hasText: 'Mentés' }).click();
        await parent.locator('#child-name', { hasText: 'Petike' }).waitFor({ timeout: 10000 });
        const renamed = await sql('test', `select avatar from public.children where nickname = 'Petike'`);
        expect(renamed.length === 1 && renamed[0].avatar === '🦄', `átnevezés: ${JSON.stringify(renamed)}`);

        // A meghívott felnőtt tulajdonos lesz a családban
        await parent.locator('button:visible', { hasText: 'Vissza a csoportokhoz' }).click();
        const family = parent.locator('.card', { has: parent.locator('h2', { hasText: 'Teszt család' }) });
        await openSetting(family, 'Családtagok');
        await family.locator('li', { hasText: 'masik@teszt.matek' }).locator('.role-select').selectOption('owner');
        await parent.waitForTimeout(1500);
        const role = await sql('test', `select m.role from public.group_members m join public.adults a on a.id = m.adult_id where a.email = 'masik@teszt.matek'`);
        expect(role[0] && role[0].role === 'owner', `masik szerepe: ${JSON.stringify(role)}`);

        // Utolsó tulajdonos védelme + csoport törlése a benne lévő gyerekkel
        await openSetting(parent.locator('#new-group-card'), 'Új család');
        await parent.fill('#group-name', 'Próba csoport');
        await parent.locator('#new-group-card .btn').click();
        const probe = parent.locator('.card', { has: parent.locator('h2', { hasText: 'Próba csoport' }) });
        await probe.waitFor();
        const probeId = (await sql('test', `select id from public.groups where name = 'Próba csoport'`))[0].id;
        const adminId = (await sql('test', `select id from public.adults where email = 'admin@teszt.matek'`))[0].id;
        const demote = await rpc('set_member_role', await adultToken(parent), { p_group_id: probeId, p_adult_id: adminId, p_role: 'member' });
        expect(!demote.ok && JSON.stringify(demote.data).includes('tulajdonos'), `az utolsó tulajdonost le lehetett fokozni: ${JSON.stringify(demote.data)}`);
        await openSetting(probe, 'Gyerek hozzáadása');
        await probe.locator('.add-child input[name=nickname]').fill('Ideiglenes');
        await probe.locator('.add-child .btn').click();
        await parent.locator('.child-btn', { hasText: 'Ideiglenes' }).waitFor({ timeout: 10000 });
        await openSetting(probe, 'Család törlése');
        await probe.locator('[data-act="delete"]').click();
        await parent.locator('.card h2', { hasText: 'Próba csoport' }).waitFor({ state: 'detached', timeout: 10000 });
        const probeLeft = await sql('test', `select (select count(*) from public.groups where name = 'Próba csoport') g,
            (select count(*) from public.children where nickname = 'Ideiglenes') c`);
        expect(+probeLeft[0].g === 0 && +probeLeft[0].c === 0, `a törölt csoportból maradt: ${JSON.stringify(probeLeft[0])}`);

        // Saját fiók törlése (a meghívott felnőtt): a család megmarad az adminnál
        const other = await newContext(browser);
        other.removeAllListeners('dialog');
        other.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'masik@teszt.matek' : undefined));
        await other.goto((await magicLink('masik@teszt.matek')).action_link);
        await other.locator('#view-home').waitFor({ state: 'visible', timeout: 20000 });
        await mode(other, 'account');
        await openSetting(other, 'Saját fiók törlése');
        await other.locator('#home-account .btn', { hasText: 'Saját fiók törlése' }).click();
        await other.locator('#login-msg', { hasText: 'töröltük' }).waitFor({ timeout: 10000 });
        const after = await sql('test', `select (select count(*) from auth.users where email = 'masik@teszt.matek') u,
            (select count(*) from public.group_members m join public.groups g on g.id = m.group_id where g.name = 'Teszt család') tagok`);
        expect(+after[0].u === 0 && +after[0].tagok === 1, `törlés után: ${JSON.stringify(after[0])} (0 fiók, 1 tag kell)`);
        expect(!other.errors.length, `JS hiba: ${other.errors.join(' | ')}`);
        await other.context().close();
    });

    await test('Új feladattípusok és mai gyakorlás: feltöltés, utolsó válasz ideje, szülői térkép', async (expect) => {
        await kid.reload();
        await kid.locator('#child-chip').waitFor({ state: 'visible', timeout: 20000 });
        // az előző teszt "Csillag mindenkinek" ajándéka most ugrik fel ezen a tableten
        await kid.locator('#star-overlay').waitFor({ state: 'visible', timeout: 15000 })
            .then(() => kid.locator('#star-overlay .btn-start').click()).catch(() => {});
        const petike = await childId('Petike');
        const before = await sql('test', `select count(*) as n from public.answers where child_id = '${petike}'`);
        await kid.locator('#table-picker .btn-op[data-op="mis"]').click();
        await playExam(kid, 7); // ? × 7 = …: 11 feladat
        await kid.locator('#table-picker .btn-op[data-op="rem"]').click();
        await playExam(kid, 3); // … : 3 = …, maradék …: 27 feladat
        await kid.locator('#daily-btn').click();
        expect((await kid.evaluate(() => quizDeck.length)) === 10, 'a mai gyakorlás nem 10 feladat');
        await answerUntilResults(kid);
        await kid.waitForFunction(() => {
            const box = JSON.parse(localStorage.getItem('szorzo_outbox') || '{"answers":[1]}');
            return !box.answers.length && !box.sessions.length;
        }, null, { timeout: 20000 });
        const counts = await sql('test', `select (select count(*) from public.answers where child_id = '${petike}' and op = 'mis') mis,
            (select count(*) from public.answers where child_id = '${petike}' and op = 'rem') rem,
            (select count(*) from public.answers where child_id = '${petike}') total,
            (select count(*) from public.quiz_sessions where child_id = '${petike}' and mode = 'daily') daily,
            (select count(*) from public.quiz_sessions where child_id = '${petike}' and op in ('mis', 'rem')) typed`);
        const c = counts[0];
        expect(+c.mis >= 11 && +c.rem >= 27 && +c.total === +before[0].n + 48 && +c.daily === 1 && +c.typed === 2,
            `a felhőben: ${JSON.stringify(c)} (11 hiányzó, 27 maradékos, +48 válasz, 1 mai, 2 új típusú teszt)`);
        const kidToken = await kid.evaluate(() => JSON.parse(localStorage.getItem('szorzo-eszkoz-auth')).access_token);
        const facts = await rpc('child_facts', kidToken, { p_child_id: petike });
        expect(facts.ok && facts.data.length && facts.data.every((f) => f.last_at), 'a child_facts nem adja az utolsó válasz idejét');
        const local = await kid.evaluate(() => Object.values(JSON.parse(localStorage.getItem('szorzo_facts'))).every((f) => f.t > 0));
        expect(local, 'a letöltött feladatoknál nincs meg az utolsó válasz ideje');

        // A szülő térképén is látszik
        await mode(parent, 'family');
        await parent.locator('.child-btn', { hasText: 'Petike' }).first().click();
        await parent.locator('#view-child').waitFor({ state: 'visible' });
        const colored = () => parent.locator('#child-heatmap .hm-cell:not(.hm-none):not(.hm-head)').count();
        await parent.locator('#view-child .op-toggle button', { hasText: 'Hiányzó' }).click();
        const misColored = await colored();
        await parent.locator('#view-child .op-toggle button', { hasText: 'Maradékos' }).click();
        const remColored = await colored();
        expect(misColored >= 11 && remColored >= 9, `a szülő térképén: hiányzó ${misColored} (legalább 11), maradékos ${remColored} (legalább 9: a 3-as sor) színes mező`);
        await shot(parent, '9-uj-feladattipusok');
        expect(!kid.errors.length && !parent.errors.length, `JS hiba: ${[...kid.errors, ...parent.errors].join(' | ')}`);
    });

    await browser.close();
    srv.close();
    const failed = results.filter((r) => !r).length;
    console.log(`\n${results.length - failed}/${results.length} felhő teszt rendben.`);
    process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(2); });
