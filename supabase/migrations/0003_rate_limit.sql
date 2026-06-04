-- 0003 — fixed-window rate limiting for the edge functions.
--
-- A leaked anon key lets anyone call llm-proxy / realtime-token and spend our
-- provider credits. This caps requests per client (per IP, per function) in a
-- fixed time window. The edge functions call rl_check() before doing any work;
-- it atomically increments the window counter and returns whether we're under
-- the limit.

create table if not exists public.rate_limits (
  id           text primary key,           -- "<function>:<client-ip>"
  count        int not null default 0,
  window_start timestamptz not null default now()
);

-- Locked down: only the SECURITY DEFINER function below ever touches this table.
alter table public.rate_limits enable row level security;

create or replace function public.rl_check(p_key text, p_limit int, p_window_secs int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  insert into public.rate_limits (id, count, window_start)
    values (p_key, 1, now())
  on conflict (id) do update
    set count = case
          when rate_limits.window_start < now() - make_interval(secs => p_window_secs) then 1
          else rate_limits.count + 1
        end,
        window_start = case
          when rate_limits.window_start < now() - make_interval(secs => p_window_secs) then now()
          else rate_limits.window_start
        end
  returning count into v_count;
  return v_count <= p_limit;       -- true = allowed, false = over the limit
end;
$$;

revoke all on function public.rl_check(text, int, int) from public;
grant execute on function public.rl_check(text, int, int) to anon, authenticated, service_role;
