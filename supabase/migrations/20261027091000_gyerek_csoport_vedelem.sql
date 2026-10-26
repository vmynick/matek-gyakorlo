-- A gyereket csoportból csak a remove_child_from_group függvénnyel lehet kivenni, hogy az utolsó csoportjából
-- ne kerülhessen ki (akkor senki nem látná). Hozzáadni továbbra is közvetlenül lehet (saját csoportba).
drop policy "gyerek-csoport: tulajdonos veheti ki" on public.child_groups;
revoke delete on public.child_groups from authenticated;
