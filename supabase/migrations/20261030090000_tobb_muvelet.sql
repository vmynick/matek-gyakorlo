-- Több művelet egyszerre (1.9): a gyerek és a feladatot kiosztó felnőtt bármelyik műveleteket együtt választhatja.
--
-- A teszt és a kiosztott feladat op mezője vesszővel elválasztott lista, mindig ugyanabban a sorrendben
-- ("mul,div,rem"). A régi "mix" (vegyes = szorzás és osztás) érvényes marad: a meglévő sorokban és a még
-- nem frissült appokban is előfordul.

alter table public.quiz_sessions
    drop constraint quiz_sessions_op_check,
    add constraint quiz_sessions_op_check check (
        op = 'mix' or op ~ '^(mul|div|mis|rem)(,(mul|div|mis|rem)){0,3}$');

alter table public.assignments
    drop constraint assignments_op_check,
    add constraint assignments_op_check check (
        op = 'mix' or op ~ '^(mul|div|mis|rem)(,(mul|div|mis|rem)){0,3}$');
