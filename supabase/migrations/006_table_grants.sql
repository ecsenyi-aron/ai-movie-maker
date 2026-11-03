-- 006: táblajogok (a hiányzó GRANT-ok pótlása)
GRANT USAGE ON SCHEMA public TO authenticated, service_role;

-- Bejelentkezett felhasználó: az RLS-szabályok szabják meg, melyik sorhoz fér hozzá
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;

-- A költségnapló a felhasználónak csak olvasható
REVOKE INSERT, UPDATE, DELETE ON public.budget_ledger FROM authenticated;

-- Szerver oldali kulcs
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;
