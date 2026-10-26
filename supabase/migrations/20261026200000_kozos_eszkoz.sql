-- Közös eszköz: egy tabletet több gyerek is használhat. Mindegyik gyereket a saját eszköz-kódjával kötik
-- össze ugyanazzal az eszközzel; induláskor a gyerek kiválasztja magát (opcionális 4 jegyű gyerek-PIN-nel).

-- Egy eszköz több gyerekhez is tartozhat
alter table public.child_devices drop constraint child_devices_pkey;
alter table public.child_devices add primary key (user_id, child_id);
create index child_devices_user_idx on public.child_devices (user_id);

-- Opcionális gyerek-PIN, hogy a testvérek ne egymás nevében gyakoroljanak. Nem erős védelem (4 számjegy),
-- ezért elég egy egyszerű lenyomat: az eszköz internet nélkül is ellenőrizni tudja. Null = nincs PIN.
alter table public.children add column pin_hash text check (pin_hash ~ '^[0-9a-f]{64}$');

-- Az eszközhöz kötött gyerek-e (a válaszokat csak a saját, összekötött gyerekeinek írhatja)
create function public.is_my_device_child(p_child uuid) returns boolean
language sql stable security definer set search_path = '' as $$
    select exists (select 1 from public.child_devices d
                   where d.user_id = (select auth.uid()) and d.child_id = p_child)
$$;
grant execute on function public.is_my_device_child(uuid) to authenticated;

drop policy "válasz: csak a gyerek saját eszközéről" on public.answers;
create policy "válasz: csak a gyerek saját eszközéről" on public.answers
    for insert to authenticated with check (
        public.is_my_device_child(child_id) and device_user_id = (select auth.uid()));

drop policy "teszt: csak a gyerek saját eszközéről" on public.quiz_sessions;
create policy "teszt: csak a gyerek saját eszközéről" on public.quiz_sessions
    for insert to authenticated with check (
        public.is_my_device_child(child_id) and device_user_id = (select auth.uid()));

drop function public.my_device_child();

-- Kód beváltása: az eszköz mostantól további gyerekekhez is köthető (a meglévő kapcsolatai megmaradnak)
create or replace function public.redeem_device_code(p_code text) returns jsonb
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
        on conflict (user_id, child_id) do update set linked_at = now(), last_seen = now();
    select * into v_child from public.children where id = v_code.child_id;
    return jsonb_build_object('id', v_child.id, 'nickname', v_child.nickname, 'avatar', v_child.avatar,
                              'pin_hash', v_child.pin_hash);
end;
$$;

-- Gyerek-PIN beállítása / törlése (a gyerek felnőttjei). A lenyomat: sha256("<gyerek azonosító>:<PIN>").
create function public.set_child_pin(p_child_id uuid, p_pin text) returns void
language plpgsql security definer set search_path = '' as $$
begin
    if not public.can_manage_child(p_child_id) then
        raise exception 'Nincs jogod ehhez a gyerekhez';
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
grant execute on function public.set_child_pin(uuid, text) to authenticated;
revoke execute on function public.set_child_pin(uuid, text) from public, anon;
revoke execute on function public.is_my_device_child(uuid) from public, anon;
