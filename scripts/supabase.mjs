// Supabase karbantartás a kezelő API-n (Management API) keresztül – adatbázis-jelszó nélkül.
//
//   node scripts/supabase.mjs status  <prod|test>   projekt állapota, lefutott migrációk
//   node scripts/supabase.mjs migrate <prod|test>   a supabase/migrations alatti új migrációk futtatása
//   node scripts/supabase.mjs auth    <prod|test>   bejelentkezési beállítások (belépő link, meghívás, levelek)
//   node scripts/supabase.mjs admin   <prod|test>   az admin meghívása (MATEK_ADMIN_EMAIL)
//   node scripts/supabase.mjs sql     <prod|test> "<SQL>"
//
// A titkok környezeti változóból jönnek (scripts/set-secrets.ps1 állítja be): SUPABASE_ACCESS_TOKEN,
// SMTP_USER, SMTP_PASSWORD, MATEK_ADMIN_EMAIL. Az értékeket a szkript sosem írja ki.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PROJECTS = {
    prod: { ref: 'yqnlpzhmfrnzmvakjdyq', key: 'sb_publishable_eNoNBeDeJYUrpIEQPOohtw_U7KMvCUm' },
    test: { ref: 'wcbhcaxsveltvugygjgr', key: 'sb_publishable_5OPb2V8i4ZlWlWknJ1bi6A_xJ7PPQM3' },
};
export const APP_URL = 'https://vmynick.github.io/matek-gyakorlo/';
export const TEST_APP_URL = 'http://127.0.0.1:4173/'; // a helyi tesztszerver fix címe (a belépő linkekhez)

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Környezeti változó; Windowson a felhasználói változók közül is (ha a terminál a beállítás előtt indult)
export function readEnv(name) {
    if (process.env[name]) return process.env[name];
    if (process.platform !== 'win32') return undefined;
    try {
        const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const m = out.match(new RegExp(`${name}\\s+REG_\\w+\\s+(.*)`));
        return m ? m[1].trim() : undefined;
    } catch {
        return undefined;
    }
}

function need(name) {
    const v = readEnv(name);
    if (!v) throw new Error(`Hiányzik a(z) ${name} környezeti változó (scripts/titkok-beallitasa.cmd)`);
    return v;
}

async function api(method, apiPath, body) {
    const res = await fetch(`https://api.supabase.com${apiPath}`, {
        method,
        headers: { Authorization: `Bearer ${need('SUPABASE_ACCESS_TOKEN')}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${apiPath} -> ${res.status}: ${text.slice(0, 500)}`);
    return text ? JSON.parse(text) : null;
}

export const sql = (env, query) => api('POST', `/v1/projects/${PROJECTS[env].ref}/database/query`, { query });

async function appliedMigrations(env) {
    const list = await api('GET', `/v1/projects/${PROJECTS[env].ref}/database/migrations`);
    return new Set((list || []).map((m) => m.name));
}

async function migrate(env) {
    const dir = path.join(ROOT, 'supabase', 'migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const done = await appliedMigrations(env);
    let count = 0;
    for (const file of files) {
        const name = file.replace(/\.sql$/, '');
        if (done.has(name)) continue;
        console.log(`  migráció: ${name}`);
        await api('POST', `/v1/projects/${PROJECTS[env].ref}/database/migrations`,
            { name, query: fs.readFileSync(path.join(dir, file), 'utf8') });
        count++;
        // a Supabase a futás másodpercét használja a nyilvántartás kulcsának: egy másodpercen belül kettő ütközne
        await new Promise((ok) => setTimeout(ok, 1100));
    }
    // Az adatbázis API (PostgREST) frissítse a sémáról tárolt adatait, különben az új függvényeket nem látja
    if (count) await sql(env, "notify pgrst, 'reload schema';");
    console.log(count ? `${count} migráció lefutott (${env})` : `Nincs új migráció (${env})`);
}

const MAIL_HTML = `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:480px;margin:auto;color:#1e293b">
  <h2 style="color:#4f46e5">✨ Szorzótábla Mester</h2>
  <p>Szia! Belépő linket kértél, vagy meghívást kaptál a Szorzótábla Mester szülői / tanári felületére.</p>
  <p style="margin:24px 0"><a href="{{ .ConfirmationURL }}"
     style="background:#4f46e5;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:bold">Belépés</a></p>
  <p style="color:#64748b;font-size:14px">A link egy óráig érvényes, és egyszer használható.
     Ha nem te kérted, nyugodtan hagyd figyelmen kívül ezt a levelet.</p>
</div>`;

async function configureAuth(env) {
    const isTest = env === 'test';
    const appUrl = isTest ? TEST_APP_URL : APP_URL;
    const config = {
        site_url: appUrl,
        uri_allow_list: isTest ? `${TEST_APP_URL}**` : `${APP_URL}**`,
        disable_signup: false, // a meghívottak a belépő linkkel jönnek létre; a hook szűr
        external_email_enabled: true,
        external_anonymous_users_enabled: true, // a gyerekek eszközei
        mailer_otp_exp: 3600,
        hook_before_user_created_enabled: true,
        hook_before_user_created_uri: 'pg-functions://postgres/public/hook_before_user_created',
    };
    // Levélküldés Gmailen keresztül (a beépített csak a projekt csapattagjainak küld). A tesztprojekt nem küld levelet.
    if (!isTest) {
        Object.assign(config, {
            smtp_host: 'smtp.gmail.com',
            smtp_port: '465',
            smtp_user: need('SMTP_USER'),
            smtp_pass: need('SMTP_PASSWORD'),
            smtp_admin_email: need('SMTP_USER'),
            smtp_sender_name: 'Szorzótábla Mester',
            rate_limit_email_sent: 30,
        });
    }
    await api('PATCH', `/v1/projects/${PROJECTS[env].ref}/config/auth`, config);
    // Magyar levélsablon: az ingyenes csomagban csak saját levélküldővel (SMTP) módosítható, ezért külön lépés
    if (!isTest) {
        await api('PATCH', `/v1/projects/${PROJECTS[env].ref}/config/auth`, {
            mailer_subjects_magic_link: 'Belépés – Szorzótábla Mester',
            mailer_templates_magic_link_content: MAIL_HTML,
            mailer_subjects_confirmation: 'Belépés – Szorzótábla Mester',
            mailer_templates_confirmation_content: MAIL_HTML,
        });
    }
    console.log(`Bejelentkezési beállítások frissítve (${env}): ${appUrl}`);
}

async function inviteAdmin(env) {
    const email = need('MATEK_ADMIN_EMAIL').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('A MATEK_ADMIN_EMAIL nem e-mail cím');
    const quoted = `'${email.replace(/'/g, "''")}'`;
    await sql(env, `
        insert into public.invitations (email, can_create_groups, make_admin)
        select ${quoted}, true, true
        where not exists (select 1 from public.adults where email = ${quoted})
          and not exists (select 1 from public.invitations where email = ${quoted} and make_admin and accepted_at is null);
        update public.adults set is_admin = true, can_create_groups = true where email = ${quoted};`);
    console.log(`Admin meghívó kész (${env}). Belépés: ${env === 'test' ? TEST_APP_URL : APP_URL}szulo.html`);
}

async function status(env) {
    const project = await api('GET', `/v1/projects/${PROJECTS[env].ref}`);
    console.log(`${env}: ${project.name} (${project.region}) – ${project.status}`);
    console.log('  migrációk:', [...await appliedMigrations(env)].join(', ') || '-');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [command, env, extra] = process.argv.slice(2);
    if (!PROJECTS[env]) {
        console.error('Használat: node scripts/supabase.mjs <status|migrate|auth|admin|sql> <prod|test> [SQL]');
        process.exit(2);
    }
    const commands = { status, migrate, auth: configureAuth, admin: inviteAdmin,
        sql: async (e) => console.log(JSON.stringify(await sql(e, extra), null, 2)) };
    commands[command](env).catch((e) => { console.error(`HIBA: ${e.message}`); process.exit(1); });
}
