-- Osztályok: csatlakozási kód csak osztályhoz; a tanár meghívhat szülőket (családot hozhatnak létre, osztályt nem);
-- összesített feladat-térkép egy csoportra; kiosztott feladatok határidővel.

-- ============================================================================
-- Jogok: családot és osztályt külön jog hozhat létre
-- ============================================================================

alter table public.adults add column can_create_classes boolean not null default false;
update public.adults set can_create_classes = can_create_groups; -- az eddigi (admin által meghívott) létrehozók maradnak
alter table public.invitations add column can_create_classes boolean not null default false;
update public.invitations set can_create_classes = can_create_groups where accepted_at is null;

create or replace function public.accept_invitations() returns jsonb
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
                can_create_classes = can_create_classes or v_inv.can_create_classes,
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

-- Az admin által "saját csoporttal" meghívott felnőtt családot és osztályt is létrehozhat (tanár)
create or replace function public.invite_adult(
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
        update public.adults
            set can_create_groups = can_create_groups or p_can_create_groups,
                can_create_classes = can_create_classes or p_can_create_groups
            where id = v_existing;
        if p_group_id is not null then
            insert into public.group_members (group_id, adult_id, role)
                values (p_group_id, v_existing, p_group_role)
                on conflict (group_id, adult_id) do nothing;
        end if;
        return 'added';
    end if;

    insert into public.invitations (email, group_id, group_role, can_create_groups, can_create_classes, invited_by)
        values (v_email, p_group_id, p_group_role, p_can_create_groups, p_can_create_groups, (select auth.uid()));
    return 'invited';
end;
$$;

-- Szülő meghívása tanártól (osztály tulajdonosától): a szülő családot hozhat létre, osztályt nem,
-- és nem lesz tagja az osztálynak (a gyerekét a csatlakozási kóddal teszi be)
create function public.invite_parent(p_email text) returns text
language plpgsql security definer set search_path = '' as $$
declare
    v_email text := lower(trim(p_email));
begin
    if not (public.is_admin() or exists (
            select 1 from public.group_members m join public.groups g on g.id = m.group_id
            where m.adult_id = (select auth.uid()) and m.role = 'owner' and g.kind = 'class')) then
        raise exception 'Szülőt az osztály tulajdonosa (tanár) hívhat meg';
    end if;
    if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
        raise exception 'Hibás e-mail cím';
    end if;
    if exists (select 1 from public.adults where email = v_email) then
        update public.adults set can_create_groups = true where email = v_email;
        return 'added';
    end if;
    insert into public.invitations (email, can_create_groups, can_create_classes, invited_by)
        values (v_email, true, false, (select auth.uid()));
    return 'invited';
end;
$$;

create or replace function public.create_group(p_name text, p_kind text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
    v_id uuid;
begin
    if p_kind = 'class' and not exists (select 1 from public.adults
            where id = (select auth.uid()) and (can_create_classes or is_admin)) then
        raise exception 'Osztályt csak az hozhat létre, akit tanárként hívtak meg';
    end if;
    if p_kind = 'family' and not exists (select 1 from public.adults
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

drop function public.admin_adults();
create function public.admin_adults()
returns table (id uuid, email text, is_admin boolean, can_create_groups boolean, can_create_classes boolean,
               created_at timestamptz, last_sign_in_at timestamptz, groups jsonb)
language plpgsql stable security definer set search_path = '' as $$
begin
    if not public.is_admin() then
        raise exception 'Ehhez admin jog kell';
    end if;
    return query
    select a.id, a.email, a.is_admin, a.can_create_groups, a.can_create_classes, a.created_at, u.last_sign_in_at,
           coalesce((select jsonb_agg(jsonb_build_object('name', g.name, 'kind', g.kind, 'role', m.role) order by g.name)
                     from public.group_members m join public.groups g on g.id = m.group_id
                     where m.adult_id = a.id), '[]'::jsonb)
    from public.adults a left join auth.users u on u.id = a.id
    order by a.email;
end;
$$;

create function public.admin_set_rights(p_adult uuid, p_families boolean, p_classes boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
    if not public.is_admin() then
        raise exception 'Ehhez admin jog kell';
    end if;
    update public.adults set can_create_groups = p_families, can_create_classes = p_classes where id = p_adult;
end;
$$;

-- ============================================================================
-- Csatlakozási kód csak osztályhoz (családba kóddal senki nem tehet be gyereket)
-- ============================================================================

delete from public.group_join_codes j using public.groups g where g.id = j.group_id and g.kind <> 'class';

create or replace function public.create_group_join_code(p_group_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    v_code text;
    v_expires timestamptz := now() + interval '14 days';
begin
    if not public.is_group_owner(p_group_id) then
        raise exception 'Csak a csoport tulajdonosa kérhet csatlakozási kódot';
    end if;
    if (select kind from public.groups where id = p_group_id) <> 'class' then
        raise exception 'Csatlakozási kód csak osztályhoz kérhető';
    end if;
    delete from public.group_join_codes where group_id = p_group_id;
    loop
        v_code := public.random_code();
        begin
            insert into public.group_join_codes (code, group_id, created_by, expires_at)
                values (v_code, p_group_id, (select auth.uid()), v_expires);
            exit;
        exception when unique_violation then
            -- ritka ütközés: új kód
        end;
    end loop;
    return jsonb_build_object('code', v_code, 'expires_at', v_expires);
end;
$$;

create or replace function public.join_group_with_code(p_child_id uuid, p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    v_uid uuid := (select auth.uid());
    v_group public.groups;
begin
    if not exists (select 1 from public.adults where id = v_uid) or not public.can_manage_child(p_child_id) then
        return jsonb_build_object('error', 'Nincs jogod ehhez a gyerekhez');
    end if;
    if (select count(*) from public.device_code_attempts
        where user_id = v_uid and attempted_at > now() - interval '1 hour') >= 10 then
        return jsonb_build_object('error', 'Túl sok próbálkozás. Próbáld újra egy óra múlva!');
    end if;
    insert into public.device_code_attempts (user_id) values (v_uid);

    select g.* into v_group from public.group_join_codes j join public.groups g on g.id = j.group_id
        where j.code = upper(trim(p_code)) and j.expires_at > now() and g.kind = 'class';
    if not found then
        return jsonb_build_object('error', 'Hibás vagy lejárt kód');
    end if;
    insert into public.child_groups (child_id, group_id) values (p_child_id, v_group.id) on conflict do nothing;
    return jsonb_build_object('group_id', v_group.id, 'name', v_group.name, 'kind', v_group.kind);
end;
$$;

-- ============================================================================
-- Összesítés egy csoportra ("együtt" nézet). security invoker: csak a látható gyerekek adatai.
-- ============================================================================

-- Gyerekenként és feladatonként a legutóbbi 5 válasz (ugyanaz a logika, mint a child_facts-ben)
create function public.group_child_facts(p_group_id uuid)
returns table (child_id uuid, op text, tbl smallint, other smallint, n integer, recent text, avg_ms integer,
               score numeric, weak boolean)
language sql stable security invoker set search_path = '' as $$
    with members as (select cg.child_id from public.child_groups cg where cg.group_id = p_group_id),
    ranked as (
        select a.child_id, a.op, a.tbl, a.other, a.outcome, a.ms,
               row_number() over (partition by a.child_id, a.op, a.tbl, a.other order by a.answered_at desc) as rn,
               row_number() over (partition by a.child_id, a.op, a.tbl, a.other, a.outcome = 'o'
                                  order by a.answered_at desc) as rn_kind
        from public.answers a join members m on m.child_id = a.child_id
    ),
    per_child as (
        select r.child_id, r.op, r.tbl, r.other, count(*)::integer as n,
               string_agg(r.outcome, '' order by r.rn desc) filter (where r.rn <= 5) as recent,
               (avg(r.ms) filter (where r.outcome = 'o' and r.rn_kind <= 5))::integer as avg_ms
        from ranked r group by r.child_id, r.op, r.tbl, r.other
    )
    select pc.child_id, pc.op, pc.tbl, pc.other, pc.n, pc.recent, pc.avg_ms,
           (select avg(case c when 'o' then 1 when 'b' then 0.5 else 0 end)
              from regexp_split_to_table(pc.recent, '') as c),
           (pc.recent ~ '[bx]' and pc.recent !~ 'oo$')
    from per_child pc
$$;

-- Feladatonként a csoport összesítése: hány gyerek gyakorolta, átlagos eredmény, kinek kell még gyakorolnia
create function public.group_facts(p_group_id uuid)
returns table (op text, tbl smallint, other smallint, kids integer, n integer, avg_score numeric,
               weak_kids jsonb, avg_ms integer)
language sql stable security invoker set search_path = '' as $$
    select f.op, f.tbl, f.other, count(*)::integer, sum(f.n)::integer, round(avg(f.score), 3),
           coalesce(jsonb_agg(jsonb_build_object('nickname', c.nickname, 'avatar', c.avatar) order by c.nickname)
                    filter (where f.weak), '[]'::jsonb),
           (avg(f.avg_ms))::integer
    from public.group_child_facts(p_group_id) f join public.children c on c.id = f.child_id
    group by f.op, f.tbl, f.other
$$;

-- Gyerekenkénti áttekintés a csoportban
create function public.group_children_summary(p_group_id uuid)
returns table (child_id uuid, nickname text, avatar text, answers_total integer, answers_7d integer,
               weak integer, last_answer timestamptz)
language sql stable security invoker set search_path = '' as $$
    select c.id, c.nickname, c.avatar,
           (select count(*) from public.answers a where a.child_id = c.id)::integer,
           (select count(*) from public.answers a where a.child_id = c.id and a.answered_at > now() - interval '7 days')::integer,
           (select count(*) from public.group_child_facts(p_group_id) f where f.child_id = c.id and f.weak)::integer,
           (select max(a.answered_at) from public.answers a where a.child_id = c.id)
    from public.child_groups cg join public.children c on c.id = cg.child_id
    where cg.group_id = p_group_id
    order by c.nickname
$$;

-- ============================================================================
-- Kiosztott feladatok
-- ============================================================================

create table public.assignments (
    id uuid primary key default gen_random_uuid(),
    group_id uuid not null references public.groups (id) on delete cascade,
    op text not null check (op in ('mul', 'div', 'mix')),
    tables smallint[] not null check (cardinality(tables) between 1 and 11 and tables <@ '{0,1,2,3,4,5,6,7,8,9,10}'),
    mode text not null check (mode in ('practice', 'exam')),
    question_count smallint check (question_count between 1 and 242), -- null = az összes
    due_date date,
    note text check (char_length(note) <= 120),
    created_by uuid references public.adults (id) on delete set null,
    created_at timestamptz not null default now()
);
create index assignments_group_idx on public.assignments (group_id);

alter table public.quiz_sessions add column assignment_id uuid references public.assignments (id) on delete set null;
create index quiz_sessions_assignment_idx on public.quiz_sessions (assignment_id);

-- A gyerek eszköze látja a gyereke csoportjainak feladatait
create function public.device_in_group(p_group uuid) returns boolean
language sql stable security definer set search_path = '' as $$
    select exists (select 1 from public.child_groups cg
                   join public.child_devices d on d.child_id = cg.child_id
                   where cg.group_id = p_group and d.user_id = (select auth.uid()))
$$;

alter table public.assignments enable row level security;
revoke all on table public.assignments from anon, authenticated;
grant select, delete on public.assignments to authenticated;
grant all on public.assignments to service_role;
create policy "feladat: a csoport tagjai és a gyerekek eszközei" on public.assignments
    for select to authenticated using (public.is_group_member(group_id) or public.device_in_group(group_id));
create policy "feladat: törlés a kiadónak vagy a tulajdonosnak" on public.assignments
    for delete to authenticated using (created_by = (select auth.uid()) or public.is_group_owner(group_id));

-- A teszt csak akkor köthető feladathoz, ha a feladat a gyerek valamelyik csoportjáé
drop policy "teszt: csak a gyerek saját eszközéről" on public.quiz_sessions;
create policy "teszt: csak a gyerek saját eszközéről" on public.quiz_sessions
    for insert to authenticated with check (
        public.is_my_device_child(child_id) and device_user_id = (select auth.uid())
        and (assignment_id is null or exists (
            select 1 from public.assignments a join public.child_groups cg on cg.group_id = a.group_id
            where a.id = assignment_id and cg.child_id = quiz_sessions.child_id)));

create function public.create_assignment(p_group_id uuid, p_op text, p_tables smallint[], p_mode text,
                                         p_count smallint, p_due date, p_note text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
    v_id uuid;
begin
    if not public.is_group_member(p_group_id) then
        raise exception 'Feladatot a csoport tagja adhat ki';
    end if;
    insert into public.assignments (group_id, op, tables, mode, question_count, due_date, note, created_by)
        values (p_group_id, p_op, (select array_agg(distinct t order by t) from unnest(p_tables) t), p_mode,
                case when p_mode = 'exam' then null else p_count end, p_due, nullif(trim(p_note), ''), (select auth.uid()))
        returning id into v_id;
    return v_id;
end;
$$;

-- Feladatonként és gyerekenként: hányszor csinálta meg, a legjobb és a legutóbbi eredmény
create function public.assignment_progress(p_group_id uuid)
returns table (assignment_id uuid, child_id uuid, nickname text, avatar text, done integer, best_pct integer,
               last_pct integer, last_at timestamptz)
language sql stable security invoker set search_path = '' as $$
    select a.id, c.id, c.nickname, c.avatar,
           count(s.id)::integer, max(s.pct)::integer,
           (array_agg(s.pct order by s.finished_at desc))[1]::integer, max(s.finished_at)
    from public.assignments a
    join public.child_groups cg on cg.group_id = a.group_id
    join public.children c on c.id = cg.child_id
    left join public.quiz_sessions s on s.assignment_id = a.id and s.child_id = c.id
    where a.group_id = p_group_id
    group by a.id, c.id, c.nickname, c.avatar
$$;

-- ============================================================================
-- Jogok
-- ============================================================================

revoke execute on function
    public.invite_parent(text), public.admin_adults(), public.admin_set_rights(uuid, boolean, boolean),
    public.group_child_facts(uuid), public.group_facts(uuid), public.group_children_summary(uuid),
    public.device_in_group(uuid), public.create_assignment(uuid, text, smallint[], text, smallint, date, text),
    public.assignment_progress(uuid)
    from public, anon;
grant execute on function
    public.invite_parent(text), public.admin_adults(), public.admin_set_rights(uuid, boolean, boolean),
    public.group_child_facts(uuid), public.group_facts(uuid), public.group_children_summary(uuid),
    public.device_in_group(uuid), public.create_assignment(uuid, text, smallint[], text, smallint, date, text),
    public.assignment_progress(uuid)
    to authenticated;
