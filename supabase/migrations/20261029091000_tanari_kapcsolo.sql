-- A tanári funkciók (osztályok) az admin felületről ki- és bekapcsolhatók; alapból ki vannak kapcsolva.
--
-- Kikapcsolva nem lehet osztályt létrehozni, csatlakozási kódot kérni, gyereket osztályba tenni, és tanárt
-- (osztályt létrehozó felnőttet) meghívni. A meglévő osztályok és adataik megmaradnak: a felület elrejti őket,
-- visszakapcsoláskor újra látszanak. Az ellenőrzést triggerek végzik, így minden út (RPC, közvetlen írás) fedve van.

create table public.app_settings (
    id smallint primary key default 1 check (id = 1),
    teachers_enabled boolean not null default false,
    updated_at timestamptz not null default now()
);
insert into public.app_settings (id) values (1);

alter table public.app_settings enable row level security;
revoke all on table public.app_settings from anon, authenticated;
grant select on public.app_settings to authenticated;
grant all on public.app_settings to service_role;
create policy "beállítások: a felnőttek olvashatják" on public.app_settings
    for select to authenticated using (exists (select 1 from public.adults where id = (select auth.uid())));

create function public.teachers_enabled() returns boolean
language sql stable security definer set search_path = '' as $$
    select coalesce((select s.teachers_enabled from public.app_settings s where s.id = 1), false)
$$;

create function public.admin_set_teachers_enabled(p_enabled boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
    if not public.is_admin() then
        raise exception 'Ehhez admin jog kell';
    end if;
    update public.app_settings set teachers_enabled = p_enabled, updated_at = now() where id = 1;
end;
$$;

-- Trigger: osztály, csatlakozási kód és tanár-meghívó csak bekapcsolt tanári funkciókkal
create function public.require_teachers_enabled() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
    if not public.teachers_enabled() then
        raise exception 'A tanári funkciók (osztályok) ki vannak kapcsolva';
    end if;
    return new;
end;
$$;

-- Trigger: gyerek csak bekapcsolt tanári funkciókkal kerülhet osztályba (családba mindig)
create function public.require_teachers_for_class_child() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
    if (select g.kind from public.groups g where g.id = new.group_id) = 'class' and not public.teachers_enabled() then
        raise exception 'A tanári funkciók (osztályok) ki vannak kapcsolva';
    end if;
    return new;
end;
$$;

create trigger groups_class_needs_teachers before insert on public.groups
    for each row when (new.kind = 'class') execute function public.require_teachers_enabled();
create trigger join_codes_need_teachers before insert on public.group_join_codes
    for each row execute function public.require_teachers_enabled();
create trigger invitations_teacher_needs_teachers before insert on public.invitations
    for each row when (new.can_create_classes) execute function public.require_teachers_enabled();
create trigger child_groups_class_needs_teachers before insert on public.child_groups
    for each row execute function public.require_teachers_for_class_child();

revoke execute on function public.teachers_enabled(), public.admin_set_teachers_enabled(boolean),
    public.require_teachers_enabled(), public.require_teachers_for_class_child() from public, anon;
grant execute on function public.admin_set_teachers_enabled(boolean) to authenticated;
revoke execute on function public.teachers_enabled(), public.require_teachers_enabled(),
    public.require_teachers_for_class_child() from authenticated;
