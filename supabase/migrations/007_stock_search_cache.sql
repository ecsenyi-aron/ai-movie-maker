-- 007: Pixabay keresési gyorsítótár (24 órás gyorsítótár)
-- Csak a szerveroldali service_role kliens használhatja.
-- A felhasználó (anon/authenticated) nem látja és nem módosíthatja.

CREATE TABLE IF NOT EXISTS public.stock_search_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query_key text UNIQUE NOT NULL,
  response jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stock_search_cache_fetched_at_idx
  ON public.stock_search_cache (fetched_at);

-- RLS bekapcsolva, felhasználói policy nélkül: a service_role megkerüli az RLS-t,
-- az anon és authenticated szerepkör viszont nem lát semmit.
ALTER TABLE public.stock_search_cache ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.stock_search_cache FROM anon;
REVOKE ALL ON public.stock_search_cache FROM authenticated;
GRANT ALL ON public.stock_search_cache TO service_role;
