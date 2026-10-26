-- Kezelés: gyerek több csoportban (osztály-csatlakozási kód), csoportok / gyerekek / tagok szerkesztése,
-- admin felnőtt-kezelés és saját fiók törlése.

-- ============================================================================
-- Segédek (csak belső használatra: kívülről nem hívhatók)
-- ============================================================================

-- 6 karakteres kód félreérthető betűk (I, L, O, 0, 1) nélkül
create function public.random_code() returns text
language plpgsql volatile set search_path = '' as $$
declare
    v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    v_bytes bytea := uuid_send(gen_random_uuid());
    v_code text := '';
begin
    for i in 0..5 loop
        v_code := v_code || substr(v_alphabet, (get_byte(v_bytes, i) % 31) + 1, 1);
    end loop;
    return v_code;
end;
$$;

-- Csoport törlése a csak ebben a csoportban lévő gyerekekkel (és minden eredményükkel) együtt
create function public.delete_group_internal(p_group_id uuid) returns void
language sql security definer set search_path = '' as $$
    delete from public.children c
        where exists (select 1 from public.child_groups cg where cg.child_id = c.id and cg.group_id = p_group_id)
          and not exists (select 1 from public.child_groups cg where cg.child_id = c.id and cg.group_id <> p_group_id);
    delete from public.groups where id = p_group_id;
$$;

-- Felnőtt teljes eltávolítása: ahol egyedül volt, a csoport törlődik; ahol egyetlen tulajdonos volt,
-- a legrégebbi tag lesz a tulajdonos; a függő meghívói és a fiókja törlődnek.
create function public.remove_adult_internal(p_adult uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
    v_group uuid;
    v_email text := (select email from public.adults where id = p_adult);
begin
    for v_group in
        select m.group_id from public.group_members m
        where m.adult_id = p_adult
          and not exists (select 1 from public.group_members o where o.group_id = m.group_id and o.adult_id <> p_adult)
    loop
        perform public.delete_group_internal(v_group);
    end loop;

    update public.group_members m set role = 'owner'
        where (m.group_id, m.adult_id) in (
            select distinct on (o.group_id) o.group_id, o.adult_id
            from public.group_members o
            where o.adult_id <> p_adult
              and o.group_id in (select g.group_id from public.group_members g
                                 where g.adult_id = p_adult and g.role = 'owner')
              and not exists (select 1 from public.group_members x
                              where x.group_id = o.group_id and x.role = 'owner' and x.adult_id <> p_adult)
            order by o.group_id, o.added_at);

    delete from public.invitations where email = v_email and accepted_at is null;
    delete from auth.users where id = p_adult; -- az adults sor és a tagságok is törlődnek (cascade)
end;
$$;

revoke execute on function public.random_code(), public.delete_group_internal(uuid), public.remove_adult_internal(uuid)
    from public, anon, authenticated;

-- ============================================================================
-- Osztály-csatlakozási kód: a tanár kódot ad, a szülő azzal teszi be a gyerekét az osztályba.
-- A szülő nem lesz az osztály tagja (nem látja a többi gyereket); a tanár csak ezt a gyereket látja.
-- ============================================================================

create table public.group_join_codes (
    code text primary key check (code ~ '^[A-Z2-9]{6}$'),
    group_id uuid not null unique references public.groups (id) on delete cascade, -- csoportonként egy érvényes kód
    created_by uuid references public.adults (id) on delete set null,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null default now() + interval '14 days'
);
alter table public.group_join_codes enable row level security;
revoke all on table public.group_join_codes from anon, authenticated;
grant select, delete on public.group_join_codes to authenticated;
grant all on public.group_join_codes to service_role;
create policy "csatlakozási kód: a csoport tulajdonosának" on public.group_join_codes
    for select to authenticated using (public.is_group_owner(group_id));
create policy "csatlakozási kód: visszavonás" on public.group_join_codes
    for delete to authenticated using (public.is_group_owner(group_id));

create function public.create_group_join_code(p_group_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    v_code text;
    v_expires timestamptz := now() + interval '14 days';
begin
    if not public.is_group_owner(p_group_id) then
        raise exception 'Csak a csoport tulajdonosa kérhet csatlakozási kódot';
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

-- Hibánál nem dob kivételt (különben a próbálkozás-számláló visszagördülne)
create function public.join_group_with_code(p_child_id uuid, p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    v_uid uuid := (select auth.uid());
    v_join public.group_join_codes;
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

    select * into v_join from public.group_join_codes where code = upper(trim(p_code)) and expires_at > now();
    if not found then
        return jsonb_build_object('error', 'Hibás vagy lejárt kód');
    end if;
    insert into public.child_groups (child_id, group_id) values (p_child_id, v_join.group_id)
        on conflict do nothing;
    select * into v_group from public.groups where id = v_join.group_id;
    return jsonb_build_object('group_id', v_group.id, 'name', v_group.name, 'kind', v_group.kind);
end;
$$;

-- ============================================================================
-- A gyerek csoportjai
-- ============================================================================

-- A gyerek csoportjai a kezelő felnőtt szemszögéből. Más család nevét nem mutatja ki (csak az osztályokét).
create function public.child_groups_info(p_child_id uuid)
returns table (group_id uuid, name text, kind text, is_member boolean, is_owner boolean, can_remove boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
    if not public.can_manage_child(p_child_id) then
        raise exception 'Nincs jogod ehhez a gyerekhez';
    end if;
    return query
    select g.id,
           case when public.is_group_member(g.id) or g.kind = 'class' then g.name else null end,
           g.kind,
           public.is_group_member(g.id),
           public.is_group_owner(g.id),
           public.is_group_owner(g.id) or (g.kind = 'class' and public.owns_family_of(p_child_id))
    from public.child_groups cg join public.groups g on g.id = cg.group_id
    where cg.child_id = p_child_id
    order by g.kind, g.name;
end;
$$;

-- A gyerek valamelyik családi csoportjának tulajdonosa vagyok-e (szülőként kiveheti az osztályból)
create function public.owns_family_of(p_child uuid) returns boolean
language sql stable security definer set search_path = '' as $$
    select exists (select 1 from public.child_groups cg
                   join public.groups g on g.id = cg.group_id and g.kind = 'family'
                   join public.group_members m on m.group_id = g.id
                   where cg.child_id = p_child and m.adult_id = (select auth.uid()) and m.role = 'owner')
$$;

-- Gyerek kivétele egy csoportból: a csoport tulajdonosa, vagy a szülő (családi tulajdonos) egy osztályból.
-- A tanár a családból nem veheti ki. Az utolsó csoportból nem lehet (akkor inkább a gyereket kell törölni).
create function public.remove_child_from_group(p_child_id uuid, p_group_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
    v_kind text := (select kind from public.groups where id = p_group_id);
begin
    if not (public.is_group_owner(p_group_id) or (v_kind = 'class' and public.owns_family_of(p_child_id))) then
        raise exception 'Ebből a csoportból nem veheted ki a gyereket';
    end if;
    if (select count(*) from public.child_groups where child_id = p_child_id) <= 1 then
        raise exception 'Ez a gyerek egyetlen csoportja. Ha már nem kell, töröld a gyereket.';
    end if;
    delete from public.child_groups where child_id = p_child_id and group_id = p_group_id;
end;
$$;

-- ============================================================================
-- Csoportok és tagok szerkesztése
-- ============================================================================

create function public.delete_group(p_group_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
    if not public.is_group_owner(p_group_id) then
        raise exception 'Csak a csoport tulajdonosa törölheti a csoportot';
    end if;
    perform public.delete_group_internal(p_group_id);
end;
$$;

create function public.set_member_role(p_group_id uuid, p_adult_id uuid, p_role text) returns void
language plpgsql security definer set search_path = '' as $$
begin
    if not public.is_group_owner(p_group_id) then
        raise exception 'Csak a csoport tulajdonosa módosíthat szerepet';
    end if;
    if p_role not in ('owner', 'member') then
        raise exception 'Hibás szerep';
    end if;
    if p_role = 'member' and not exists (select 1 from public.group_members
            where group_id = p_group_id and role = 'owner' and adult_id <> p_adult_id) then
        raise exception 'Legalább egy tulajdonosnak maradnia kell';
    end if;
    update public.group_members set role = p_role where group_id = p_group_id and adult_id = p_adult_id;
end;
$$;

-- Tag eltávolítása (tulajdonos), vagy kilépés (saját magam)
create function public.remove_member(p_group_id uuid, p_adult_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
    if not (public.is_group_owner(p_group_id) or p_adult_id = (select auth.uid())) then
        raise exception 'Csak a csoport tulajdonosa távolíthat el tagot';
    end if;
    if not exists (select 1 from public.group_members where group_id = p_group_id and adult_id <> p_adult_id) then
        raise exception 'Ő a csoport egyetlen tagja. Ha már nem kell, töröld a csoportot.';
    end if;
    if exists (select 1 from public.group_members where group_id = p_group_id and adult_id = p_adult_id and role = 'owner')
       and not exists (select 1 from public.group_members
                       where group_id = p_group_id and role = 'owner' and adult_id <> p_adult_id) then
        raise exception 'Ő az egyetlen tulajdonos: előbb adj tulajdonosi jogot valaki másnak.';
    end if;
    delete from public.group_members where group_id = p_group_id and adult_id = p_adult_id;
end;
$$;

-- A tagságot innentől csak a fenti szabályokkal lehet bontani (az utolsó tulajdonos ne tűnhessen el)
drop policy "tagság: tulajdonos eltávolít, vagy kilépek" on public.group_members;
revoke delete on public.group_members from authenticated;

-- ============================================================================
-- Admin: felnőttek kezelése (a gyerekek eredményeibe az admin így sem lát bele)
-- ============================================================================

create function public.admin_adults()
returns table (id uuid, email text, is_admin boolean, can_create_groups boolean, created_at timestamptz,
               last_sign_in_at timestamptz, groups jsonb)
language plpgsql stable security definer set search_path = '' as $$
begin
    if not public.is_admin() then
        raise exception 'Ehhez admin jog kell';
    end if;
    return query
    select a.id, a.email, a.is_admin, a.can_create_groups, a.created_at, u.last_sign_in_at,
           coalesce((select jsonb_agg(jsonb_build_object('name', g.name, 'kind', g.kind, 'role', m.role) order by g.name)
                     from public.group_members m join public.groups g on g.id = m.group_id
                     where m.adult_id = a.id), '[]'::jsonb)
    from public.adults a left join auth.users u on u.id = a.id
    order by a.email;
end;
$$;

create function public.admin_set_can_create_groups(p_adult uuid, p_value boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
    if not public.is_admin() then
        raise exception 'Ehhez admin jog kell';
    end if;
    update public.adults set can_create_groups = p_value where id = p_adult;
end;
$$;

create function public.admin_remove_adult(p_adult uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
    if not public.is_admin() then
        raise exception 'Ehhez admin jog kell';
    end if;
    if p_adult = (select auth.uid()) then
        raise exception 'Saját magadat a „Saját fiók törlése” résznél törölheted';
    end if;
    perform public.remove_adult_internal(p_adult);
end;
$$;

-- ============================================================================
-- Saját fiók törlése (adatvédelem)
-- ============================================================================

create function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
declare
    v_uid uuid := (select auth.uid());
begin
    if not exists (select 1 from public.adults where id = v_uid) then
        raise exception 'Csak felnőtt fiók törölhető így';
    end if;
    if public.is_admin() and not exists (select 1 from public.adults where is_admin and id <> v_uid) then
        raise exception 'Te vagy az egyetlen admin: előbb legyen más is admin, vagy maradj.';
    end if;
    perform public.remove_adult_internal(v_uid);
end;
$$;

-- ============================================================================
-- Jogok: a bejelentkezettek hívhatják (mindegyik maga ellenőrzi a jogot), névtelenül senki
-- ============================================================================

revoke execute on function
    public.create_group_join_code(uuid), public.join_group_with_code(uuid, text), public.child_groups_info(uuid),
    public.owns_family_of(uuid), public.remove_child_from_group(uuid, uuid), public.delete_group(uuid),
    public.set_member_role(uuid, uuid, text), public.remove_member(uuid, uuid), public.admin_adults(),
    public.admin_set_can_create_groups(uuid, boolean), public.admin_remove_adult(uuid), public.delete_my_account()
    from public, anon;
grant execute on function
    public.create_group_join_code(uuid), public.join_group_with_code(uuid, text), public.child_groups_info(uuid),
    public.owns_family_of(uuid), public.remove_child_from_group(uuid, uuid), public.delete_group(uuid),
    public.set_member_role(uuid, uuid, text), public.remove_member(uuid, uuid), public.admin_adults(),
    public.admin_set_can_create_groups(uuid, boolean), public.admin_remove_adult(uuid), public.delete_my_account()
    to authenticated;
