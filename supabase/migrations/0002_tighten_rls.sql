-- 0002 — tighten RLS (#3). Replaces the hackathon `allow_all` policies.
--
-- WHAT THIS FIXES: the anon role could previously DELETE or overwrite ANY row in
-- any table. This migration removes blanket access and, in particular, removes
-- all anon DELETE rights (anti-griefing) and locks the command-queue status
-- transitions to the server-side claim_command() function.
--
-- WHAT THIS DOES NOT FIX: the anon key is public, so a determined caller who has
-- it can still INSERT/UPDATE rows the policies allow. True per-cook isolation
-- needs Supabase Auth (a real JWT) OR routing every write through an edge
-- function that holds the service-role key. That is the recommended next step;
-- this migration is the honest in-between that stops casual tampering/deletion.

-- ---------- drop the permissive policies ----------
do $$
declare t text;
begin
  foreach t in array array['devices','commands','recipes','preferences'] loop
    execute format('drop policy if exists allow_all on public.%I', t);
  end loop;
end $$;

-- ---------- devices: read + upsert compartments, never delete ----------
create policy devices_read   on public.devices for select to anon, authenticated using (true);
create policy devices_insert on public.devices for insert to anon, authenticated with check (true);
create policy devices_update on public.devices for update to anon, authenticated using (true) with check (true);

-- ---------- commands: phone enqueues + reads; status transitions are server-side ----------
-- INSERT (enqueue a dispense) and SELECT (watch status) only. No direct UPDATE/
-- DELETE: claim_command() is SECURITY DEFINER and owns the pending->running move.
create policy commands_read   on public.commands for select to anon, authenticated using (true);
create policy commands_insert on public.commands for insert to anon, authenticated with check (true);

-- ---------- recipes: read + add, never delete via anon ----------
create policy recipes_read   on public.recipes for select to anon, authenticated using (true);
create policy recipes_insert on public.recipes for insert to anon, authenticated with check (true);

-- ---------- preferences: read + upsert, never delete via anon ----------
create policy preferences_read   on public.preferences for select to anon, authenticated using (true);
create policy preferences_insert on public.preferences for insert to anon, authenticated with check (true);
create policy preferences_update on public.preferences for update to anon, authenticated using (true) with check (true);
