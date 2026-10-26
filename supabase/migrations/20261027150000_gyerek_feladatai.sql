-- A gyerek kiosztott feladatai a felnőtt szemszögéből (a szülő akkor is látja az osztály feladatait, ha ő nem
-- tagja az osztálynak): melyiket csinálta már meg és hány százalékkal. Más család nevét nem mutatja ki.
create function public.child_assignments(p_child_id uuid)
returns table (id uuid, group_name text, group_kind text, op text, tables smallint[], mode text,
               question_count smallint, due_date date, note text, created_at timestamptz, done integer, last_pct integer)
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
            order by s.finished_at desc limit 1)::integer
    from public.assignments a
    join public.child_groups cg on cg.group_id = a.group_id and cg.child_id = p_child_id
    join public.groups g on g.id = a.group_id
    order by a.created_at desc;
end;
$$;

revoke execute on function public.child_assignments(uuid) from public, anon;
grant execute on function public.child_assignments(uuid) to authenticated;
