-- "A család az első": ha a gyereknek van családja, az eszközeit, a PIN-jét, a nevét, a statisztikája törlését
-- és az osztályhoz csatlakoztatását csak a család tagjai kezelhetik, a gyereket törölni csak a család tulajdonosa.
-- A tanár (osztály) a családi gyereket látja, feladatot adhat neki, és kiveheti az osztályából, de nem töröl és
-- nem nyúl a család tabletjeihez. Ha a gyerek csak osztályban van (pl. iskolai tableten), a tanár kezeli.

create function public.is_primary_adult(p_child uuid) returns boolean
language sql stable security definer set search_path = '' as $$
    select case
        when exists (select 1 from public.child_groups cg join public.groups g on g.id = cg.group_id
                     where cg.child_id = p_child and g.kind = 'family')
        then exists (select 1 from public.child_groups cg
                     join public.groups g on g.id = cg.group_id and g.kind = 'family'
                     join public.group_members m on m.group_id = g.id
                     where cg.child_id = p_child and m.adult_id = (select auth.uid()))
        else public.can_manage_child(p_child)
    end
$$;

create function public.is_primary_owner(p_child uuid) returns boolean
language sql stable security definer set search_path = '' as $$
    select case
        when exists (select 1 from public.child_groups cg join public.groups g on g.id = cg.group_id
                     where cg.child_id = p_child and g.kind = 'family')
        then public.owns_family_of(p_child)
        else public.owns_child(p_child)
    end
$$;

revoke execute on function public.is_primary_adult(uuid), public.is_primary_owner(uuid) from public, anon;
grant execute on function public.is_primary_adult(uuid), public.is_primary_owner(uuid) to authenticated;

-- Gyerek adatai, törlése
drop policy "gyerek: módosítás a csoport tagjainak" on public.children;
create policy "gyerek: módosítás a család tagjainak" on public.children
    for update to authenticated using (public.is_primary_adult(id)) with check (public.is_primary_adult(id));
drop policy "gyerek: törlés a tulajdonosnak" on public.children;
create policy "gyerek: törlés a család tulajdonosának" on public.children
    for delete to authenticated using (public.is_primary_owner(id));

-- Eszközök és eszköz-kódok
drop policy "eszköz: leválasztás" on public.child_devices;
create policy "eszköz: leválasztás" on public.child_devices
    for delete to authenticated using (user_id = (select auth.uid()) or public.is_primary_adult(child_id));
drop policy "eszköz-kód: a gyerek felnőttjeinek" on public.device_codes;
create policy "eszköz-kód: a gyerek felnőttjeinek" on public.device_codes
    for select to authenticated using (public.is_primary_adult(child_id));
drop policy "eszköz-kód: visszavonás" on public.device_codes;
create policy "eszköz-kód: visszavonás" on public.device_codes
    for delete to authenticated using (public.is_primary_adult(child_id));

create or replace function public.create_device_code(p_child_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    v_code text;
    v_expires timestamptz := now() + interval '24 hours';
begin
    if not public.is_primary_adult(p_child_id) then
        raise exception 'Eszköz-kódot a gyerek családja kérhet';
    end if;
    delete from public.device_codes
        where child_id = p_child_id and (used_at is not null or expires_at < now());
    loop
        v_code := public.random_code();
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

create or replace function public.set_child_pin(p_child_id uuid, p_pin text) returns void
language plpgsql security definer set search_path = '' as $$
begin
    if not public.is_primary_adult(p_child_id) then
        raise exception 'A gyerek-PIN-t a gyerek családja állíthatja be';
    end if;
    if p_pin is not null and p_pin !~ '^[0-9]{4}$' then
        raise exception 'A PIN pontosan 4 számjegy';
    end if;
    update public.children
        set pin_hash = case when p_pin is null then null
                            else encode(sha256(convert_to(p_child_id::text || ':' || p_pin, 'UTF8')), 'hex') end
        where id = p_child_id;
end;
$$;

create or replace function public.clear_child_stats(p_child_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
    if not public.is_primary_adult(p_child_id) then
        raise exception 'A statisztikát a gyerek családja törölheti';
    end if;
    delete from public.answers where child_id = p_child_id;
    delete from public.quiz_sessions where child_id = p_child_id;
end;
$$;

create or replace function public.join_group_with_code(p_child_id uuid, p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    v_uid uuid := (select auth.uid());
    v_group public.groups;
begin
    if not exists (select 1 from public.adults where id = v_uid) or not public.is_primary_adult(p_child_id) then
        return jsonb_build_object('error', 'Osztályhoz a gyerek családja csatlakoztathatja');
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
