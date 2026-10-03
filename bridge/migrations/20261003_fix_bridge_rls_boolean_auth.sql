create or replace function private.bridge_request_authorized()
returns boolean
language plpgsql
security definer
set search_path = private, public
as $$
declare
  jwt_role text := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role',
    nullif(current_setting('request.jwt', true), '')::jsonb->>'role'
  );
  supplied text := nullif(current_setting('request.headers', true), '')::jsonb->>'x-antigravity-bridge-key';
  supplied_hash text;
begin
  if jwt_role = 'service_role' then
    return true;
  end if;
  if jwt_role <> 'anon' or supplied is null or length(supplied) < 32 then
    return false;
  end if;

  supplied_hash := encode(sha256(convert_to(supplied, 'utf8')), 'hex');
  return exists(
    select 1
    from private.bridge_client_keys
    where enabled = true
      and secret_sha256 = supplied_hash
  );
exception when others then
  return false;
end;
$$;

revoke all on function private.bridge_request_authorized() from public, authenticated;
grant usage on schema private to anon, service_role;
grant execute on function private.bridge_request_authorized() to anon, service_role;

drop policy if exists bridge_anon_jobs_select on public.agent_jobs;
drop policy if exists bridge_anon_jobs_update on public.agent_jobs;
drop policy if exists bridge_anon_events_insert on public.agent_events;

create policy bridge_anon_jobs_select
on public.agent_jobs
for select
to anon
using (private.bridge_request_authorized());

create policy bridge_anon_jobs_update
on public.agent_jobs
for update
to anon
using (private.bridge_request_authorized())
with check (private.bridge_request_authorized());

create policy bridge_anon_events_insert
on public.agent_events
for insert
to anon
with check (private.bridge_request_authorized());
