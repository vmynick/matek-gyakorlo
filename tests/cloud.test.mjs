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
    try { await fn(expect); } catch (e) { checks.push({ ok: false, msg: `kivétel: ${e.message.split('\n')[0]}` }); }
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
    page.on('dialog', (d) => d.accept());
    await page.addInitScript(() => { if (!localStorage.getItem('szorzo_sound')) localStorage.setItem('szorzo_sound', '0'); });
    return page;
}

async function playExam(page, table, wrongFirst = 0) {
    await page.locator('#mode-exam').click();
    await page.evaluate(() => { selectedTables = []; renderTableSelector(); }); // csak az adott tábla legyen kijelölve
    await page.locator('#tables-grid button').nth(table).click();
    await page.locator('#screen-setup .btn-start').click();
    for (let i = 0; i < 40 && await page.locator('#screen-quiz.active').count(); i++) {
        const q = await page.evaluate(() => {
            const a = +document.getElementById('q-factor1').innerText, b = +document.getElementById('q-factor2').innerText;
            return document.getElementById('q-op').innerText.trim() === ':' ? a / b : a * b;
        });
        for (const d of String(i < wrongFirst ? q + 1 : q)) await page.getByRole('button', { name: d, exact: true }).click();
        await page.locator('.action-submit').click();
        await page.waitForTimeout(i < wrongFirst ? 1700 : 800);
    }
    await page.locator('#screen-results.active').waitFor({ timeout: 5000 });
    await page.locator('#screen-results .btn-start').click();
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
        expect(await parent.locator('#admin-card').isVisible(), 'az admin kártya hiányzik');
        await parent.fill('#group-name', 'Teszt család');
        await parent.locator('#new-group-card .btn').click();
        await parent.locator('.card h2', { hasText: 'Teszt család' }).waitFor();
        await parent.locator('summary', { hasText: 'Gyerek hozzáadása' }).click();
        await parent.locator('.avatars button', { hasText: '🐼' }).click();
        await parent.fill('.add-child input[name=nickname]', 'Bori');
        await parent.locator('.add-child .btn').click();
        await parent.locator('.child-btn', { hasText: 'Bori' }).click();
        await parent.locator('#view-child').waitFor({ state: 'visible' });
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
        await parent.locator('button', { hasText: 'Vissza a csoportokhoz' }).click();
        await parent.locator('.child-btn', { hasText: 'Bori' }).click();
        await parent.locator('#view-child').waitFor({ state: 'visible' });
        const summary = await parent.locator('#child-summary').innerText();
        expect(summary.includes('2 teszt') && summary.includes('22 megválaszolt'), `összegzés: ${summary}`);
        const colored = await parent.locator('#child-heatmap .hm-cell:not(.hm-none):not(.hm-head)').count();
        expect(colored === 22, `színes mezők a térképen: ${colored} (22 kell)`);
        expect((await parent.locator('#device-list li').count()) === 1, 'az összekötött eszköz nem látszik');
        await shot(parent, '3-statisztika');
    });

    await test('Meghívás az appból: a meghívott belép és látja a családot', async (expect) => {
        // a teszt projekt nem küld levelet: a levélküldést itt "elfogjuk"
        await parent.route('**/auth/v1/otp**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
        await parent.locator('button', { hasText: 'Vissza a csoportokhoz' }).click();
        await parent.locator('summary', { hasText: 'Felnőttek' }).click();
        await parent.fill('.invite input[name=email]', 'masik@teszt.matek');
        await parent.locator('.invite .btn').click();
        await parent.locator('.msg.ok', { hasText: 'Meghívó elküldve' }).waitFor({ timeout: 10000 });
        await parent.locator('#pending-list', { hasText: 'masik@teszt.matek' }).waitFor({ timeout: 10000 });

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
        await parent.locator('#device-list button', { hasText: 'leválasztás' }).click();
        await parent.locator('#device-list', { hasText: 'Még nincs összekötött eszköz' }).waitFor({ timeout: 10000 });
        await kid.reload();
        await kid.locator('#child-chip').waitFor({ state: 'hidden', timeout: 20000 });
        expect(!(await kid.evaluate(() => localStorage.getItem('szorzo_child'))), 'a gyerek app még összekötöttnek hiszi magát');
    });

    await browser.close();
    srv.close();
    const failed = results.filter((r) => !r).length;
    console.log(`\n${results.length - failed}/${results.length} felhő teszt rendben.`);
    process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(2); });
