-- SpiceDispenser schema — the phone <-> ESP32 interface contract.
-- Hackathon settings: permissive RLS (anon can do everything). Tighten later.

-- ---------- devices ----------
create table if not exists public.devices (
  device_id text primary key,
  name      text,
  slots     jsonb not null default '{}'::jsonb,  -- {"0":"paprika","1":"cumin",...}
  last_seen timestamptz
);

-- ---------- commands (the queue) ----------
create table if not exists public.commands (
  id         uuid primary key default gen_random_uuid(),
  device_id  text not null,
  type       text not null default 'dispense',     -- dispense | home | ping
  payload    jsonb not null default '{}'::jsonb,    -- dispense: {"slot":2,"dose_units":3}
  status     text not null default 'pending',       -- pending|running|done|error
  error      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists commands_device_pending_idx
  on public.commands (device_id, status, created_at);

-- ---------- recipes ----------
create table if not exists public.recipes (
  id    uuid primary key default gen_random_uuid(),
  name  text not null,
  steps jsonb not null default '[]'::jsonb           -- [{"slot":0,"dose_units":2},...]
);

-- ---------- preferences ----------
create table if not exists public.preferences (
  user_id text not null default 'shared',
  key     text not null,
  value   text,
  primary key (user_id, key)
);

-- ---------- atomic command claim (prevents double-dispense) ----------
-- A device calls this instead of SELECT-then-UPDATE. SKIP LOCKED + single-row
-- update means two concurrent polls can never grab the same command.
create or replace function public.claim_command(p_device_id text)
returns public.commands
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed public.commands;
begin
  update public.commands c
     set status = 'running', updated_at = now()
   where c.id = (
     select id from public.commands
      where device_id = p_device_id and status = 'pending'
      order by created_at
      limit 1
      for update skip locked
   )
   returning c.* into claimed;
  return claimed;  -- NULL row if nothing pending
end;
$$;

-- ---------- realtime ----------
alter publication supabase_realtime add table public.commands;

-- ---------- permissive RLS (hackathon) ----------
do $$
declare t text;
begin
  foreach t in array array['devices','commands','recipes','preferences'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists allow_all on public.%I', t);
    execute format(
      'create policy allow_all on public.%I for all to anon, authenticated using (true) with check (true)', t);
  end loop;
end $$;

grant execute on function public.claim_command(text) to anon, authenticated;
