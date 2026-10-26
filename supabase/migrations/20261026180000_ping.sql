-- Ébresztő: az ingyenes Supabase projekt 7 nap tétlenség után szünetel. A GitHub Actions hetente kétszer
-- meghívja ezt a függvényt (.github/workflows/keepalive.yml), így a projekt nyári szünetben is működik.
-- Semmilyen adatot nem ad vissza, csak az időt.
create function public.ping() returns timestamptz
language sql stable set search_path = '' as $$
    select now()
$$;

revoke execute on function public.ping() from public;
grant execute on function public.ping() to anon, authenticated;
