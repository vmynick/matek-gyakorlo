-- Szorzótábla Mester – többfelhasználós alap (1. szakasz)
--
-- Felnőttek (szülő / tanár): csak meghívóval jöhet létre fiók, e-mailes belépő linkkel lépnek be.
-- Csoportok: család vagy osztály. A csoport tagjai (felnőttek) a csoport összes gyerekét látják.
-- Gyerekek: csak becenév és avatar. A gyerek eszköze névtelen (anonymous) felhasználó, amit egy
-- egyszer használatos eszköz-kód köt a gyerekhez; így csak a saját gyereke adatait látja és írja.
-- Minden táblán sorszintű jogosultság (RLS) van; ami nincs külön engedélyezve, az tilos.

-- ============================================================================
-- Táblák
-- ============================================================================

create table public.adults (
    id uuid primary key references auth.users (id) on delete cascade,
    email text not null unique,
    display_name text check (char_length(display_name) <= 60),
    is_admin boolean not null default false,
    can_create_groups boolean not null default false,
    created_at timestamptz not null default now()
);

create table public.groups (
    id uuid primary key default gen_random_uuid(),
    name text not null check (char_length(name) between 1 and 60),
    kind text not null check (kind in ('family', 'class')),
    created_by uuid references public.adults (id) on delete set null,
    created_at timestamptz not null default now()
);

create table public.group_members (
    group_id uuid not null references public.groups (id) on delete cascade,
    adult_id uuid not null references public.adults (id) on delete cascade,
    role text not null default 'member' check (role in ('owner', 'member')),
    added_at timestamptz not null default now(),
    primary key (group_id, adult_id)
);
create index group_members_adult_idx on public.group_members (adult_id);

-- Meghívók: a "before user created" hook csak az itt szereplő (még el nem fogadott) címeket engedi regisztrálni
create table public.invitations (
    id uuid primary key default gen_random_uuid(),
    email text not null check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    group_id uuid references public.groups (id) on delete cascade,
    group_role text not null default 'member' check (group_role in ('owner', 'member')),
    can_create_groups boolean not null default false,
    make_admin boolean not null default false,
    invited_by uuid references public.adults (id) on delete set null,
    created_at timestamptz not null default now(),
    accepted_at timestamptz
);
create index invitations_pending_idx on public.invitations (email) where accepted_at is null;

create table public.children (
    id uuid primary key default gen_random_uuid(),
    nickname text not null check (char_length(nickname) between 1 and 30),
    avatar text not null default '🦊' check (char_length(avatar) between 1 and 8),
    created_by uuid references public.adults (id) on delete set null,
    created_at timestamptz not null default now()
);

-- Egy gyerek több csoportban is lehet (pl. családi és osztály csoport)
create table public.child_groups (
    child_id uuid not null references public.children (id) on delete cascade,
    group_id uuid not null references public.groups (id) on delete cascade,
    primary key (child_id, group_id)
);
create index child_groups_group_idx on public.child_groups (group_id);

-- Eszköz-kód: 6 karakter, félreérthető betűk (I, L, O, 0, 1) nélkül, 24 óráig érvényes, egyszer használható
create table public.device_codes (
    code text primary key check (code ~ '^[A-Z2-9]{6}$'),
    child_id uuid not null references public.children (id) on delete cascade,
    created_by uuid references public.adults (id) on delete set null,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null default now() + interval '24 hours',
    used_at timestamptz
);
create index device_codes_child_idx on public.device_codes (child_id);

-- Kód-beváltási próbálkozások (találgatás ellen: óránként legfeljebb 10)
create table public.device_code_attempts (
    user_id uuid not null,
    attempted_at timestamptz not null default now()
);
create index device_code_attempts_idx on public.device_code_attempts (user_id, attempted_at);

-- Összekötött eszközök: a névtelen eszköz-felhasználó melyik gyerekhez tartozik
create table public.child_devices (
    user_id uuid primary key references auth.users (id) on delete cascade,
    child_id uuid not null references public.children (id) on delete cascade,
    linked_at timestamptz not null default now(),
    last_seen timestamptz not null default now()
);
create index child_devices_child_idx on public.child_devices (child_id);

-- Minden megválaszolt feladat. Az azonosítót az eszköz adja, így az újraküldés nem duplikál.
-- Szorzás: other × tbl; osztás (bennfoglalás): (other·tbl) : tbl = other.
-- outcome: o = elsőre jó, b = csonttal javított, x = hibás
create table public.answers (
    id uuid primary key,
    child_id uuid not null references public.children (id) on delete cascade,
    device_user_id uuid default auth.uid() references auth.users (id) on delete set null,
    session_id uuid,
    op text not null check (op in ('mul', 'div')),
    tbl smallint not null check (tbl between 0 and 10),
    other smallint not null check (other between 0 and 10),
    outcome text not null check (outcome in ('o', 'b', 'x')),
    ms integer check (ms between 0 and 3600000),
    mode text check (mode in ('practice', 'exam', 'weak')),
    answered_at timestamptz not null,
    imported boolean not null default false
);
create index answers_child_idx on public.answers (child_id, answered_at);

-- Teszt-összesítők (a fejlődés grafikonhoz). Az eszközről átvett régi teszteknél csak a százalék ismert.
create table public.quiz_sessions (
    id uuid primary key,
    child_id uuid not null references public.children (id) on delete cascade,
    device_user_id uuid default auth.uid() references auth.users (id) on delete set null,
    mode text not null check (mode in ('practice', 'exam', 'weak')),
    op text check (op in ('mul', 'div', 'mix')),
    tables smallint[] not null default '{}',
    total smallint check (total > 0),
    correct smallint check (correct >= 0),
    errors smallint check (errors >= 0),
    bones_used smallint check (bones_used >= 0),
    duration_s integer check (duration_s >= 0),
    pct smallint not null check (pct between 0 and 100),
    finished_at timestamptz not null,
    imported boolean not null default false
);
create index quiz_sessions_child_idx on public.quiz_sessions (child_id, finished_at);

-- ============================================================================
-- Segédfüggvények a jogosultságokhoz (az RLS szabályok ezeket használják)
-- ============================================================================

create function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
    select coalesce((select a.is_admin from public.adults a where a.id = (select auth.uid())), false)
$$;

create function public.is_group_member(p_group uuid) returns boolean
language sql stable security definer set search_path = '' as $$
    select exists (select 1 from public.group_members m
                   where m.group_id = p_group and m.adult_id = (select auth.uid()))
$$;

create function public.is_group_owner(p_group uuid) returns boolean
language sql stable security definer set search_path = '' as $$
    select exists (select 1 from public.group_members m
                   where m.group_id = p_group and m.adult_id = (select auth.uid()) and m.role = 'owner')
$$;

-- Van-e közös csoportom ezzel a felnőttel (a tagok nevének mutatásához)
create function public.shares_group_with(p_adult uuid) returns boolean
language sql stable security definer set search_path = '' as $$
    select exists (select 1 from public.group_members mine
                   join public.group_members theirs on theirs.group_id = mine.group_id
                   where mine.adult_id = (select auth.uid()) and theirs.adult_id = p_adult)
$$;

-- Felnőttként kezelhetem-e a gyereket (tagja vagyok valamelyik csoportjának)
create function public.can_manage_child(p_child uuid) returns boolean
language sql stable security definer set search_path = '' as $$
    select exists (select 1 from public.child_groups cg
                   join public.group_members m on m.group_id = cg.group_id
                   where cg.child_id = p_child and m.adult_id = (select auth.uid()))
$$;

-- Tulajdonosa vagyok-e a gyerek valamelyik csoportjának (törléshez)
create function public.owns_child(p_child uuid) returns boolean
language sql stable security definer set search_path = '' as $$
    select exists (select 1 from public.child_groups cg
                   join public.group_members m on m.group_id = cg.group_id
                   where cg.child_id = p_child and m.adult_id = (select auth.uid()) and m.role = 'owner')
$$;

-- A gyerek eszközéhez kötött gyerek (névtelen eszköz-felhasználónak)
create function public.my_device_child() returns uuid
language sql stable security definer set search_path = '' as $$
    select d.child_id from public.child_devices d where d.user_id = (select auth.uid())
$$;

-- Láthatom-e a gyerek adatait: felnőttként a csoportján keresztül, vagy a hozzá kötött eszközről
create function public.can_see_child(p_child uuid) returns boolean
language sql stable security definer set search_path = '' as $$
    select public.can_manage_child(p_child)
        or exists (select 1 from public.child_devices d
                   where d.child_id = p_child and d.user_id = (select auth.uid()))
$$;

-- ============================================================================
-- Csak meghívottak regisztrálhatnak: "before user created" auth hook
-- ============================================================================

create function public.hook_before_user_created(event jsonb) returns jsonb
language plpgsql stable as $$
declare
    v_email text := lower(trim(event -> 'user' ->> 'email'));
begin
    -- A gyerekek eszközei névtelen felhasználók: létrejöhetnek, de jogot csak eszköz-kóddal kapnak
    if coalesce((event -> 'user' ->> 'is_anonymous')::boolean, false) then
        return '{}'::jsonb;
    end if;
    if v_email is not null and exists (select 1 from public.invitations i
                                       where i.email = v_email and i.accepted_at is null) then
        return '{}'::jsonb;
    end if;
    return jsonb_build_object('error', jsonb_build_object(
        'http_code', 403,
        'message', 'Ehhez az e-mail címhez nincs meghívó. Kérj meghívót a szülőtől vagy a tanártól!'));
end;
$$;

grant usage on schema public to supabase_auth_admin;
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;
revoke execute on function public.hook_before_user_created(jsonb) from authenticated, anon, public;
grant select on table public.invitations to supabase_auth_admin;

-- ============================================================================
-- Műveletek (RPC). Mind ellenőrzi a jogosultságot, mert a táblákat közvetlenül nem lehet írni.
-- ============================================================================

-- Belépés után: a meghívók elfogadása (felnőtt fiók létrehozása, csoporttagságok)
create function public.accept_invitations() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    v_uid uuid := (select auth.uid());
    v_email text := lower(auth.jwt() ->> 'email');
    v_inv record;
begin
    if v_uid is null or v_email is null or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
        return jsonb_build_object('adult', false);
    end if;
    if not exists (select 1 from public.adults where id = v_uid) then
        if not exists (select 1 from public.invitations where email = v_email and accepted_at is null) then
            return jsonb_build_object('adult', false);
        end if;
        insert into public.adults (id, email) values (v_uid, v_email);
    end if;
    for v_inv in select * from public.invitations where email = v_email and accepted_at is null loop
        update public.adults
            set can_create_groups = can_create_groups or v_inv.can_create_groups,
                is_admin = is_admin or v_inv.make_admin
            where id = v_uid;
        if v_inv.group_id is not null then
            insert into public.group_members (group_id, adult_id, role)
                values (v_inv.group_id, v_uid, v_inv.group_role)
                on conflict (group_id, adult_id) do nothing;
        end if;
        update public.invitations set accepted_at = now() where id = v_inv.id;
    end loop;
    return jsonb_build_object('adult', true);
end;
$$;

-- Felnőtt meghívása. Csoportba a csoport tulajdonosa hívhat; csoport nélkül (saját csoportot
-- létrehozó tanár / szülő) csak az admin. Ha már van fiókja, azonnal bekerül a csoportba.
create function public.invite_adult(
    p_email text,
    p_group_id uuid default null,
    p_group_role text default 'member',
    p_can_create_groups boolean default false
) returns text
language plpgsql security definer set search_path = '' as $$
declare
    v_email text := lower(trim(p_email));
    v_existing uuid;
begin
    if not exists (select 1 from public.adults where id = (select auth.uid())) then
        raise exception 'Csak felnőtt fiókkal lehet meghívni';
    end if;
    if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
        raise exception 'Hibás e-mail cím';
    end if;
    if p_group_role not in ('owner', 'member') then
        raise exception 'Hibás szerep';
    end if;
    if (p_group_id is null or p_can_create_groups) and not public.is_admin() then
        raise exception 'Ehhez admin jog kell';
    end if;
    if p_group_id is not null and not public.is_group_owner(p_group_id) then
        raise exception 'Csak a csoport tulajdonosa hívhat meg bele';
    end if;

    select id into v_existing from public.adults where email = v_email;
    if v_existing is not null then
        update public.adults set can_create_groups = can_create_groups or p_can_create_groups
            where id = v_existing;
        if p_group_id is not null then
            insert into public.group_members (group_id, adult_id, role)
                values (p_group_id, v_existing, p_group_role)
                on conflict (group_id, adult_id) do nothing;
        end if;
        return 'added';
    end if;

    insert into public.invitations (email, group_id, group_role, can_create_groups, invited_by)
        values (v_email, p_group_id, p_group_role, p_can_create_groups, (select auth.uid()));
    return 'invited';
end;
$$;

create function public.create_group(p_name text, p_kind text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
    v_id uuid;
begin
    if not exists (select 1 from public.adults
                   where id = (select auth.uid()) and (can_create_groups or is_admin)) then
        raise exception 'Csoportot csak az hozhat létre, akit erre meghívtak';
    end if;
    insert into public.groups (name, kind, created_by)
        values (trim(p_name), p_kind, (select auth.uid()))
        returning id into v_id;
    insert into public.group_members (group_id, adult_id, role) values (v_id, (select auth.uid()), 'owner');
    return v_id;
end;
$$;

create function public.create_child(p_group_id uuid, p_nickname text, p_avatar text default '🦊') returns uuid
language plpgsql security definer set search_path = '' as $$
declare
    v_id uuid;
begin
    if not public.is_group_member(p_group_id) then
        raise exception 'Csak a csoport tagja adhat hozzá gyereket';
    end if;
    insert into public.children (nickname, avatar, created_by)
        values (trim(p_nickname), coalesce(nullif(trim(p_avatar), ''), '🦊'), (select auth.uid()))
        returning id into v_id;
    insert into public.child_groups (child_id, group_id) values (v_id, p_group_id);
    return v_id;
end;
$$;

-- Új eszköz-kód a gyerekhez (a régi, lejárt / felhasznált kódjai törlődnek)
create function public.create_device_code(p_child_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    v_bytes bytea;
    v_code text;
    v_expires timestamptz := now() + interval '24 hours';
begin
    if not public.can_manage_child(p_child_id) then
        raise exception 'Nincs jogod ehhez a gyerekhez';
    end if;
    delete from public.device_codes
        where child_id = p_child_id and (used_at is not null or expires_at < now());
    loop
        v_bytes := uuid_send(gen_random_uuid());
        v_code := '';
        for i in 0..5 loop
            v_code := v_code || substr(v_alphabet, (get_byte(v_bytes, i) % 31) + 1, 1);
        end loop;
        begin
            insert into public.device_codes (code, child_id, created_by, expires_at)
                values (v_code, p_child_id, (select auth.uid()), v_expires);
            exit;
        exception when unique_violation then
            -- ritka ütközés: új kódot generálunk
        end;
    end loop;
    return jsonb_build_object('code', v_code, 'expires_at', v_expires);
end;
$$;

-- Kód beváltása a gyerek eszközén. Hibánál nem dob kivételt, hanem hibaüzenetet ad vissza,
-- hogy a próbálkozás számlálója megmaradjon (kivételnél visszagördülne).
create function public.redeem_device_code(p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    v_uid uuid := (select auth.uid());
    v_code public.device_codes;
    v_child public.children;
begin
    if v_uid is null then
        return jsonb_build_object('error', 'Előbb be kell jelentkezni');
    end if;
    if (select count(*) from public.device_code_attempts
        where user_id = v_uid and attempted_at > now() - interval '1 hour') >= 10 then
        return jsonb_build_object('error', 'Túl sok próbálkozás. Próbáld újra egy óra múlva!');
    end if;
    insert into public.device_code_attempts (user_id) values (v_uid);

    select * into v_code from public.device_codes
        where code = upper(trim(p_code)) and used_at is null and expires_at > now()
        for update;
    if not found then
        return jsonb_build_object('error', 'Hibás vagy lejárt kód');
    end if;
    update public.device_codes set used_at = now() where code = v_code.code;
    insert into public.child_devices (user_id, child_id) values (v_uid, v_code.child_id)
        on conflict (user_id) do update set child_id = excluded.child_id, linked_at = now(), last_seen = now();
    select * into v_child from public.children where id = v_code.child_id;
    return jsonb_build_object('id', v_child.id, 'nickname', v_child.nickname, 'avatar', v_child.avatar);
end;
$$;

-- Az eszköz jelez, hogy él (a szülői felületen látszik, mikor használták utoljára)
create function public.touch_device() returns void
language sql security definer set search_path = '' as $$
    update public.child_devices set last_seen = now() where user_id = (select auth.uid())
$$;

-- Feladatonkénti statisztika (a hőtérképhez és a hibák gyakorlásához).
-- recent: a legutóbbi 5 válasz (régebbitől az újabbig), avg_ms: a legutóbbi 5 elsőre jó válasz átlagideje.
-- security invoker: a válaszok RLS szabályai érvényesek, így csak a látható gyerek adatai jönnek.
create function public.child_facts(p_child_id uuid)
returns table (op text, tbl smallint, other smallint, n integer, ok integer, bone integer, bad integer,
               recent text, avg_ms integer)
language sql stable security invoker set search_path = '' as $$
    with ranked as (
        select a.op, a.tbl, a.other, a.outcome, a.ms,
               row_number() over (partition by a.op, a.tbl, a.other order by a.answered_at desc) as rn,
               row_number() over (partition by a.op, a.tbl, a.other, a.outcome = 'o'
                                  order by a.answered_at desc) as rn_kind
        from public.answers a
        where a.child_id = p_child_id
    )
    select r.op, r.tbl, r.other,
           count(*)::integer,
           (count(*) filter (where r.outcome = 'o'))::integer,
           (count(*) filter (where r.outcome = 'b'))::integer,
           (count(*) filter (where r.outcome = 'x'))::integer,
           string_agg(r.outcome, '' order by r.rn desc) filter (where r.rn <= 5),
           (avg(r.ms) filter (where r.outcome = 'o' and r.rn_kind <= 5))::integer
    from ranked r
    group by r.op, r.tbl, r.other
$$;

-- A gyerek statisztikájának törlése (szülő / tanár)
create function public.clear_child_stats(p_child_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
    if not public.can_manage_child(p_child_id) then
        raise exception 'Nincs jogod ehhez a gyerekhez';
    end if;
    delete from public.answers where child_id = p_child_id;
    delete from public.quiz_sessions where child_id = p_child_id;
end;
$$;

-- ============================================================================
-- Jogosultságok: RLS + csak a szükséges műveletek engedélyezése
-- ============================================================================

alter table public.adults enable row level security;
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.invitations enable row level security;
alter table public.children enable row level security;
alter table public.child_groups enable row level security;
alter table public.device_codes enable row level security;
alter table public.device_code_attempts enable row level security;
alter table public.child_devices enable row level security;
alter table public.answers enable row level security;
alter table public.quiz_sessions enable row level security;

-- Bejelentkezés nélkül (anon) semmihez nincs hozzáférés
revoke all on table public.adults, public.groups, public.group_members, public.invitations, public.children,
    public.child_groups, public.device_codes, public.device_code_attempts, public.child_devices,
    public.answers, public.quiz_sessions from anon, authenticated;

-- A szerveroldali (secret kulcsos) hozzáférés mindent elér: a karbantartó szkriptek és a tesztek használják
grant all on table public.adults, public.groups, public.group_members, public.invitations, public.children,
    public.child_groups, public.device_codes, public.device_code_attempts, public.child_devices,
    public.answers, public.quiz_sessions to service_role;

grant select on public.adults to authenticated;
grant update (display_name) on public.adults to authenticated;
grant select, delete on public.groups to authenticated;
grant update (name) on public.groups to authenticated;
grant select, delete on public.group_members to authenticated;
grant select, delete on public.invitations to authenticated;
grant select, delete on public.children to authenticated;
grant update (nickname, avatar) on public.children to authenticated;
grant select, insert, delete on public.child_groups to authenticated;
grant select, delete on public.device_codes to authenticated;
grant select, delete on public.child_devices to authenticated;
grant select, insert on public.answers to authenticated;
grant select, insert on public.quiz_sessions to authenticated;

create policy "felnőtt: saját magam és a csoporttársaim" on public.adults
    for select to authenticated using (id = (select auth.uid()) or public.shares_group_with(id));
create policy "felnőtt: a saját nevem" on public.adults
    for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy "csoport: a tagjainak" on public.groups
    for select to authenticated using (public.is_group_member(id));
create policy "csoport: átnevezés a tulajdonosnak" on public.groups
    for update to authenticated using (public.is_group_owner(id)) with check (public.is_group_owner(id));
create policy "csoport: törlés a tulajdonosnak" on public.groups
    for delete to authenticated using (public.is_group_owner(id));

create policy "tagság: a csoport tagjainak" on public.group_members
    for select to authenticated using (public.is_group_member(group_id));
create policy "tagság: tulajdonos eltávolít, vagy kilépek" on public.group_members
    for delete to authenticated using (public.is_group_owner(group_id) or adult_id = (select auth.uid()));

create policy "meghívó: küldő, csoporttulajdonos, admin" on public.invitations
    for select to authenticated using (
        invited_by = (select auth.uid())
        or (group_id is not null and public.is_group_owner(group_id))
        or public.is_admin());
create policy "meghívó: visszavonás" on public.invitations
    for delete to authenticated using (
        accepted_at is null and (
            invited_by = (select auth.uid())
            or (group_id is not null and public.is_group_owner(group_id))
            or public.is_admin()));
create policy "meghívó: az auth hook olvashatja" on public.invitations
    for select to supabase_auth_admin using (true);

create policy "gyerek: aki láthatja" on public.children
    for select to authenticated using (public.can_see_child(id));
create policy "gyerek: módosítás a csoport tagjainak" on public.children
    for update to authenticated using (public.can_manage_child(id)) with check (public.can_manage_child(id));
create policy "gyerek: törlés a tulajdonosnak" on public.children
    for delete to authenticated using (public.owns_child(id));

create policy "gyerek-csoport: aki láthatja a gyereket" on public.child_groups
    for select to authenticated using (public.can_see_child(child_id));
create policy "gyerek-csoport: saját csoportomba tehetem" on public.child_groups
    for insert to authenticated with check (public.is_group_member(group_id) and public.can_manage_child(child_id));
create policy "gyerek-csoport: tulajdonos veheti ki" on public.child_groups
    for delete to authenticated using (public.is_group_owner(group_id));

create policy "eszköz-kód: a gyerek felnőttjeinek" on public.device_codes
    for select to authenticated using (public.can_manage_child(child_id));
create policy "eszköz-kód: visszavonás" on public.device_codes
    for delete to authenticated using (public.can_manage_child(child_id));

create policy "eszköz: saját magam vagy a gyerek felnőttjei" on public.child_devices
    for select to authenticated using (user_id = (select auth.uid()) or public.can_manage_child(child_id));
create policy "eszköz: leválasztás" on public.child_devices
    for delete to authenticated using (user_id = (select auth.uid()) or public.can_manage_child(child_id));

create policy "válasz: aki láthatja a gyereket" on public.answers
    for select to authenticated using (public.can_see_child(child_id));
create policy "válasz: csak a gyerek saját eszközéről" on public.answers
    for insert to authenticated with check (
        child_id = public.my_device_child() and device_user_id = (select auth.uid()));

create policy "teszt: aki láthatja a gyereket" on public.quiz_sessions
    for select to authenticated using (public.can_see_child(child_id));
create policy "teszt: csak a gyerek saját eszközéről" on public.quiz_sessions
    for insert to authenticated with check (
        child_id = public.my_device_child() and device_user_id = (select auth.uid()));

-- Függvények: alapból senki, csak a bejelentkezettek hívhatják (a jogot mindegyik maga is ellenőrzi)
revoke execute on all functions in schema public from public, anon;
grant execute on function
    public.is_admin(), public.is_group_member(uuid), public.is_group_owner(uuid), public.shares_group_with(uuid),
    public.can_manage_child(uuid), public.owns_child(uuid), public.my_device_child(), public.can_see_child(uuid),
    public.accept_invitations(), public.invite_adult(text, uuid, text, boolean), public.create_group(text, text),
    public.create_child(uuid, text, text), public.create_device_code(uuid), public.redeem_device_code(text),
    public.touch_device(), public.child_facts(uuid), public.clear_child_stats(uuid)
    to authenticated;
-- a hook függvényt csak az auth szolgáltatás hívhatja (fent már megkapta)
revoke execute on function public.hook_before_user_created(jsonb) from authenticated;
