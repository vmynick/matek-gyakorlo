-- Új feladattípusok és a "Mai gyakorlás" (1.8).
--
-- 1. Hiányzó tényező (mis): ? × tbl = other·tbl, a válasz other (tbl 1–10, other 0–10).
--    Maradékos osztás (rem): other : tbl = hányados, maradék; other az osztandó (0–99), tbl az osztó (1–10).
-- 2. Mai gyakorlás (daily): a gyereknek válogatott 10 feladat (hibásak, esedékes ismétlések, újak), új mód.
-- 3. child_facts: a feladat utolsó válaszának ideje is (last_at); ebből számolja az app, mikor esedékes az ismétlés.

alter table public.answers
    drop constraint answers_op_check,
    drop constraint answers_tbl_check,
    drop constraint answers_other_check,
    drop constraint answers_mode_check,
    add constraint answers_fact_check check (
        (op in ('mul', 'div') and tbl between 0 and 10 and other between 0 and 10)
        or (op = 'mis' and tbl between 1 and 10 and other between 0 and 10)
        or (op = 'rem' and tbl between 1 and 10 and other between 0 and 99)),
    add constraint answers_mode_check check (mode in ('practice', 'exam', 'weak', 'daily'));

alter table public.quiz_sessions
    drop constraint quiz_sessions_mode_check,
    drop constraint quiz_sessions_op_check,
    add constraint quiz_sessions_mode_check check (mode in ('practice', 'exam', 'weak', 'daily')),
    add constraint quiz_sessions_op_check check (op in ('mul', 'div', 'mix', 'mis', 'rem'));

alter table public.assignments
    drop constraint assignments_op_check,
    add constraint assignments_op_check check (op in ('mul', 'div', 'mix', 'mis', 'rem'));

-- A visszatérési sor új oszlopot kap, ezért újra kell létrehozni
drop function public.child_facts(uuid);
create function public.child_facts(p_child_id uuid)
returns table (op text, tbl smallint, other smallint, n integer, ok integer, bone integer, bad integer,
               recent text, avg_ms integer, last_at timestamptz)
language sql stable security invoker set search_path = '' as $$
    with ranked as (
        select a.op, a.tbl, a.other, a.outcome, a.ms, a.answered_at,
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
           (avg(r.ms) filter (where r.outcome = 'o' and r.rn_kind <= 5))::integer,
           max(r.answered_at)
    from ranked r
    group by r.op, r.tbl, r.other
$$;

revoke execute on function public.child_facts(uuid) from public, anon;
grant execute on function public.child_facts(uuid) to authenticated;
