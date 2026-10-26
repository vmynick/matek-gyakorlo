-- Szerepek, egy gyereknek szóló feladat, csillaggyűjtés célokra.
--
-- 1. Az admin szerepet választva hív meg: szülő (családot hozhat létre) és / vagy tanár (osztályt hozhat létre).
--    Eddig a "saját csoporttal" meghívott mindkettőt kapta.
-- 2. Feladat egy gyereknek is kiosztható (a szülő a saját gyerekének, a tanár egy diákjának), nem csak a csoportnak.
-- 3. Csillagok: a gyerek gyakorlásért csillagot kap (a szerver számolja a tesztekből), a felnőttek ajándékozhatnak is.
--    A szülő és a tanár célt tűzhet ki ("50 csillag = mozi"): a cél a kitűzése után gyűjtött csillagokat számolja,
--    így a család és az osztály céljai nem veszik el egymás elől a csillagokat. A beváltást a felnőtt jelöli.

-- ============================================================================
-- 1. Admin meghívás szerepekkel
-- ============================================================================

create function public.admin_invite(p_email text, p_families boolean, p_classes boolean) returns text
language plpgsql security definer set search_path = '' as $$
declare
    v_email text := lower(trim(p_email));
begin
    if not public.is_admin() then
        raise exception 'Ehhez admin jog kell';
    end if;
    if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
        raise exception 'Hibás e-mail cím';
    end if;
    if not (p_families or p_classes) then
        raise exception 'Válassz szerepet: szülő vagy tanár';
    end if;
    if exists (select 1 from public.adults where email = v_email) then
        update public.adults
            set can_create_groups = can_create_groups or p_families,
                can_create_classes = can_create_classes or p_classes
            where email = v_email;
        return 'added';
    end if;
    insert into public.invitations (email, can_create_groups, can_create_classes, invited_by)
        values (v_email, p_families, p_classes, (select auth.uid()));
    return 'invited';
end;
$$;

-- ============================================================================
-- 2. Feladat egy gyereknek
-- ============================================================================

alter table public.assignments add column child_id uuid references public.children (id) on delete cascade;
create index assignments_child_idx on public.assignments (child_id);

-- Melyik csoportomon keresztül kezelem a gyereket: elsőként a családján, különben az osztályán
create function public.my_group_for_child(p_child uuid) returns uuid
language sql stable security definer set search_path = '' as $$
    select g.id
    from public.child_groups cg
    join public.groups g on g.id = cg.group_id
    join public.group_members m on m.group_id = g.id and m.adult_id = (select auth.uid())
    where cg.child_id = p_child
    order by (g.kind = 'family') desc, g.created_at
    limit 1
$$;

-- Az egy gyereknek szóló feladatot csak ő (az eszközei) és a csoport tagjai látják
drop policy "feladat: a csoport tagjai és a gyerekek eszközei" on public.assignments;
create policy "feladat: a csoport tagjai és a gyerekek eszközei" on public.assignments
    for select to authenticated using (
        public.is_group_member(group_id)
        or (public.device_in_group(group_id) and (child_id is null or public.is_my_device_child(child_id))));

drop policy "teszt: csak a gyerek saját eszközéről" on public.quiz_sessions;
create policy "teszt: csak a gyerek saját eszközéről" on public.quiz_sessions
    for insert to authenticated with check (
        public.is_my_device_child(child_id) and device_user_id = (select auth.uid())
        and (assignment_id is null or exists (
            select 1 from public.assignments a join public.child_groups cg on cg.group_id = a.group_id
            where a.id = assignment_id and cg.child_id = quiz_sessions.child_id
              and (a.child_id is null or a.child_id = quiz_sessions.child_id))));

-- p_child_id: egy gyereknek szól (ilyenkor a csoportot, ha nincs megadva, a gyerekhez választja)
drop function public.create_assignment(uuid, text, smallint[], text, smallint, date, text);
create function public.create_assignment(p_group_id uuid, p_op text, p_tables smallint[], p_mode text,
                                         p_count smallint, p_due date, p_note text,
                                         p_child_id uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
    v_group uuid := p_group_id;
    v_id uuid;
begin
    if v_group is null and p_child_id is not null then
        v_group := public.my_group_for_child(p_child_id);
    end if;
    if v_group is null or not public.is_group_member(v_group) then
        raise exception 'Feladatot a csoport tagja adhat ki';
    end if;
    if p_child_id is not null and not exists (
            select 1 from public.child_groups where child_id = p_child_id and group_id = v_group) then
        raise exception 'A gyerek nincs ebben a csoportban';
    end if;
    insert into public.assignments (group_id, child_id, op, tables, mode, question_count, due_date, note, created_by)
        values (v_group, p_child_id, p_op, (select array_agg(distinct t order by t) from unnest(p_tables) t), p_mode,
                case when p_mode = 'exam' then null else p_count end, p_due, nullif(trim(p_note), ''), (select auth.uid()))
        returning id into v_id;
    return v_id;
end;
$$;

drop function public.assignment_progress(uuid);
create function public.assignment_progress(p_group_id uuid)
returns table (assignment_id uuid, child_id uuid, nickname text, avatar text, done integer, best_pct integer,
               last_pct integer, last_at timestamptz)
language sql stable security invoker set search_path = '' as $$
    select a.id, c.id, c.nickname, c.avatar,
           count(s.id)::integer, max(s.pct)::integer,
           (array_agg(s.pct order by s.finished_at desc))[1]::integer, max(s.finished_at)
    from public.assignments a
    join public.child_groups cg on cg.group_id = a.group_id and (a.child_id is null or a.child_id = cg.child_id)
    join public.children c on c.id = cg.child_id
    left join public.quiz_sessions s on s.assignment_id = a.id and s.child_id = c.id
    where a.group_id = p_group_id
    group by a.id, c.id, c.nickname, c.avatar
$$;

drop function public.child_assignments(uuid);
create function public.child_assignments(p_child_id uuid)
returns table (id uuid, group_name text, group_kind text, op text, tables smallint[], mode text,
               question_count smallint, due_date date, note text, created_at timestamptz, done integer, last_pct integer,
               for_child boolean, can_delete boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
    if not public.can_manage_child(p_child_id) then
        raise exception 'Nincs jogod ehhez a gyerekhez';
    end if;
    return query
    select a.id,
           case when public.is_group_member(g.id) or g.kind = 'class' then g.name else null end,
           g.kind, a.op, a.tables, a.mode, a.question_count, a.due_date, a.note, a.created_at,
           (select count(*) from public.quiz_sessions s where s.assignment_id = a.id and s.child_id = p_child_id)::integer,
           (select s.pct from public.quiz_sessions s where s.assignment_id = a.id and s.child_id = p_child_id
            order by s.finished_at desc limit 1)::integer,
           a.child_id is not null,
           a.created_by = (select auth.uid()) or public.is_group_owner(g.id)
    from public.assignments a
    join public.child_groups cg on cg.group_id = a.group_id and cg.child_id = p_child_id
    join public.groups g on g.id = a.group_id
    where a.child_id is null or a.child_id = p_child_id
    order by a.created_at desc;
end;
$$;

-- ============================================================================
-- 3. Csillagok és célok
-- ============================================================================

-- Ajándék csillag a felnőttől (a csoport, amelyiken keresztül adta: a gyerek ebből látja, kitől jött)
create table public.star_grants (
    id uuid primary key default gen_random_uuid(),
    child_id uuid not null references public.children (id) on delete cascade,
    group_id uuid references public.groups (id) on delete set null,
    amount smallint not null check (amount between 1 and 50),
    note text check (char_length(note) <= 80),
    created_by uuid references public.adults (id) on delete set null,
    created_at timestamptz not null default now()
);
create index star_grants_child_idx on public.star_grants (child_id, created_at);

-- Cél: a kitűzése után gyűjtött csillagokat számolja; a beváltást a felnőtt jelöli
create table public.star_goals (
    id uuid primary key default gen_random_uuid(),
    child_id uuid not null references public.children (id) on delete cascade,
    group_id uuid references public.groups (id) on delete set null,
    title text not null check (char_length(title) between 1 and 40),
    emoji text not null default '🎁' check (char_length(emoji) <= 8),
    target smallint not null check (target between 1 and 1000),
    created_by uuid references public.adults (id) on delete set null,
    created_at timestamptz not null default now(),
    redeemed_at timestamptz
);
create index star_goals_child_idx on public.star_goals (child_id);

alter table public.star_grants enable row level security;
alter table public.star_goals enable row level security;
revoke all on table public.star_grants, public.star_goals from anon, authenticated;
grant select, delete on public.star_grants, public.star_goals to authenticated;
grant all on public.star_grants, public.star_goals to service_role;
create policy "csillag: aki láthatja a gyereket" on public.star_grants
    for select to authenticated using (public.can_see_child(child_id));
create policy "csillag: visszavonás az adónak" on public.star_grants
    for delete to authenticated using (created_by = (select auth.uid()));
create policy "cél: aki láthatja a gyereket" on public.star_goals
    for select to authenticated using (public.can_see_child(child_id));
create policy "cél: törlés a kitűző csoportjának" on public.star_goals
    for delete to authenticated using (created_by = (select auth.uid()) or public.is_group_member(group_id));

-- Egy kiosztott feladat első teljesítése: a feltöltéskor rögzítjük (ha a feladatot később törlik, a csillag marad;
-- az eszköz nem állíthatja be maga)
alter table public.quiz_sessions add column assignment_bonus boolean not null default false;

create function public.mark_assignment_bonus() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
    new.assignment_bonus := new.assignment_id is not null and not exists (
        select 1 from public.quiz_sessions q where q.assignment_id = new.assignment_id and q.child_id = new.child_id);
    return new;
end;
$$;
create trigger quiz_sessions_assignment_bonus before insert on public.quiz_sessions
    for each row execute function public.mark_assignment_bonus();

update public.quiz_sessions s set assignment_bonus = true
where s.assignment_id is not null and not exists (
    select 1 from public.quiz_sessions q where q.assignment_id = s.assignment_id and q.child_id = s.child_id
      and (q.finished_at, q.id) < (s.finished_at, s.id));

-- A gyerek csillagai időrendben. Teszt: 1 csillag, ha legalább 10 feladatos (a hibák gyakorlása kevesebből is),
-- +1, ha hibátlan; egy kiosztott feladat első teljesítése +2. Az összekötés előtti (átvett) tesztek nem számítanak.
-- Ugyanez a szabály a gyerek appjában: stats.js sessionStars()
create function public.star_events(p_child uuid) returns table (at timestamptz, stars integer)
language sql stable security definer set search_path = '' as $$
    select q.finished_at,
           (case when q.total >= 10 or (q.mode = 'weak' and q.total >= 1) then 1 + (q.pct = 100)::integer else 0 end)
           + (case when q.assignment_bonus then 2 else 0 end)
    from public.quiz_sessions q where q.child_id = p_child and not q.imported
    union all
    select g.created_at, g.amount from public.star_grants g where g.child_id = p_child
$$;

create function public.child_star_total(p_child uuid) returns integer
language sql stable security definer set search_path = '' as $$
    select case when public.can_see_child(p_child)
                then coalesce((select sum(e.stars) from public.star_events(p_child) e), 0)::integer end
$$;

-- Ki adta / tűzte ki: a gyerek és a felnőtt ennyit lát (más család nevét a tanár nem látja)
create function public.star_source(p_group uuid, p_child uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
    select jsonb_build_object('kind', g.kind,
        'name', case when g.kind = 'class' or public.is_group_member(g.id) or public.is_my_device_child(p_child)
                     then g.name end)
    from public.groups g where g.id = p_group
$$;

-- Minden egyben a gyerek appjának és a felnőttnek: összes csillag, célok (haladással), legutóbbi ajándékok
create function public.child_stars(p_child_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
    if not public.can_see_child(p_child_id) then
        raise exception 'Nincs jogod ehhez a gyerekhez';
    end if;
    return jsonb_build_object(
        'total', coalesce((select sum(e.stars) from public.star_events(p_child_id) e), 0),
        'granted', coalesce((select sum(g.amount) from public.star_grants g where g.child_id = p_child_id), 0),
        'goals', coalesce((
            select jsonb_agg(jsonb_build_object(
                'id', t.id, 'title', t.title, 'emoji', t.emoji, 'target', t.target,
                'created_at', t.created_at, 'redeemed_at', t.redeemed_at,
                'progress', least(t.target, coalesce((select sum(e.stars) from public.star_events(p_child_id) e
                                                      where e.at >= t.created_at), 0)),
                'from', public.star_source(t.group_id, p_child_id),
                'can_manage', t.created_by = (select auth.uid()) or public.is_group_member(t.group_id))
                order by t.redeemed_at nulls first, t.created_at)
            from public.star_goals t
            where t.child_id = p_child_id and (t.redeemed_at is null or t.redeemed_at > now() - interval '14 days')), '[]'::jsonb),
        'grants', coalesce((
            select jsonb_agg(x.o order by x.created_at desc) from (
                select g.created_at, jsonb_build_object(
                    'id', g.id, 'amount', g.amount, 'note', g.note, 'created_at', g.created_at,
                    'from', public.star_source(g.group_id, p_child_id),
                    'can_delete', g.created_by = (select auth.uid())) as o
                from public.star_grants g where g.child_id = p_child_id
                order by g.created_at desc limit 20) x), '[]'::jsonb));
end;
$$;

create function public.create_star_goal(p_child_id uuid, p_title text, p_emoji text, p_target smallint) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
    v_group uuid := public.my_group_for_child(p_child_id);
    v_id uuid;
begin
    if v_group is null then
        raise exception 'Célt a gyerek szülője vagy tanára tűzhet ki';
    end if;
    insert into public.star_goals (child_id, group_id, title, emoji, target, created_by)
        values (p_child_id, v_group, trim(p_title), coalesce(nullif(trim(p_emoji), ''), '🎁'), p_target, (select auth.uid()))
        returning id into v_id;
    return v_id;
end;
$$;

create function public.redeem_star_goal(p_goal_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
    update public.star_goals set redeemed_at = now()
    where id = p_goal_id and redeemed_at is null
      and (created_by = (select auth.uid()) or public.is_group_member(group_id));
    if not found then
        raise exception 'Ezt a célt nem jelölheted beváltottnak';
    end if;
end;
$$;

create function public.grant_stars(p_child_id uuid, p_amount smallint, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare
    v_group uuid := public.my_group_for_child(p_child_id);
begin
    if v_group is null then
        raise exception 'Csillagot a gyerek szülője vagy tanára adhat';
    end if;
    insert into public.star_grants (child_id, group_id, amount, note, created_by)
        values (p_child_id, v_group, p_amount, nullif(trim(p_note), ''), (select auth.uid()));
end;
$$;

-- Az egész csoportnak (pl. a tanár az osztálynak): minden gyerek kap
create function public.grant_stars_group(p_group_id uuid, p_amount smallint, p_note text) returns integer
language plpgsql security definer set search_path = '' as $$
declare
    v_count integer;
begin
    if not public.is_group_member(p_group_id) then
        raise exception 'Csillagot a csoport tagja adhat';
    end if;
    insert into public.star_grants (child_id, group_id, amount, note, created_by)
        select cg.child_id, p_group_id, p_amount, nullif(trim(p_note), ''), (select auth.uid())
        from public.child_groups cg where cg.group_id = p_group_id;
    get diagnostics v_count = row_count;
    return v_count;
end;
$$;

-- Gyerekenkénti áttekintés a csoportban: a csillagok száma is
drop function public.group_children_summary(uuid);
create function public.group_children_summary(p_group_id uuid)
returns table (child_id uuid, nickname text, avatar text, answers_total integer, answers_7d integer,
               weak integer, last_answer timestamptz, stars integer)
language sql stable security invoker set search_path = '' as $$
    select c.id, c.nickname, c.avatar,
           (select count(*) from public.answers a where a.child_id = c.id)::integer,
           (select count(*) from public.answers a where a.child_id = c.id and a.answered_at > now() - interval '7 days')::integer,
           (select count(*) from public.group_child_facts(p_group_id) f where f.child_id = c.id and f.weak)::integer,
           (select max(a.answered_at) from public.answers a where a.child_id = c.id),
           public.child_star_total(c.id)
    from public.child_groups cg join public.children c on c.id = cg.child_id
    where cg.group_id = p_group_id
    order by c.nickname
$$;

-- ============================================================================
-- Jogok
-- ============================================================================

revoke execute on function
    public.admin_invite(text, boolean, boolean), public.my_group_for_child(uuid),
    public.create_assignment(uuid, text, smallint[], text, smallint, date, text, uuid),
    public.assignment_progress(uuid), public.child_assignments(uuid),
    public.star_events(uuid), public.child_star_total(uuid), public.star_source(uuid, uuid), public.child_stars(uuid),
    public.create_star_goal(uuid, text, text, smallint), public.redeem_star_goal(uuid),
    public.grant_stars(uuid, smallint, text), public.grant_stars_group(uuid, smallint, text),
    public.group_children_summary(uuid)
    from public, anon;
grant execute on function
    public.admin_invite(text, boolean, boolean), public.my_group_for_child(uuid),
    public.create_assignment(uuid, text, smallint[], text, smallint, date, text, uuid),
    public.assignment_progress(uuid), public.child_assignments(uuid),
    public.child_star_total(uuid), public.child_stars(uuid),
    public.create_star_goal(uuid, text, text, smallint), public.redeem_star_goal(uuid),
    public.grant_stars(uuid, smallint, text), public.grant_stars_group(uuid, smallint, text),
    public.group_children_summary(uuid)
    to authenticated;
-- belső: a csillagok számolása és a forrás neve csak a fenti függvényeken keresztül
revoke execute on function public.star_events(uuid), public.star_source(uuid, uuid) from authenticated;
revoke execute on function public.mark_assignment_bonus() from public, anon, authenticated;
