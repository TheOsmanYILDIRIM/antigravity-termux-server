-- Repair bridge worker auth/permissions regression.
-- Reuses the existing private.bridge_client_keys + private.bridge_check_request() design.

drop policy if exists bridge_anon_jobs_select on public.agent_jobs;
drop policy if exists bridge_anon_jobs_update on public.agent_jobs;
drop policy if exists bridge_anon_events_insert on public.agent_events;

create policy bridge_anon_jobs_select
on public.agent_jobs
for select
to anon
using ((private.bridge_check_request()) is null);

create policy bridge_anon_jobs_update
on public.agent_jobs
for update
to anon
using ((private.bridge_check_request()) is null)
with check ((private.bridge_check_request()) is null);

create policy bridge_anon_events_insert
on public.agent_events
for insert
to anon
with check ((private.bridge_check_request()) is null);

grant execute on function public.claim_agent_job_wait(text,integer,integer,integer) to anon;

create or replace function public.record_agent_event(
  p_job_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_event_type text,
  p_payload jsonb default '{}'::jsonb,
  p_lease_seconds integer default 180
)
returns bigint
language plpgsql
security invoker
set search_path to 'public'
as $function$
declare
  n integer;
  v_event_id bigint;
begin
  if p_lease_seconds < 30 or p_lease_seconds > 900 then
    raise exception 'invalid_lease_seconds';
  end if;

  update public.agent_jobs
  set heartbeat_at=now(),
      lease_expires_at=now()+make_interval(secs=>p_lease_seconds),
      updated_at=now()
  where id=p_job_id
    and worker_id=p_worker_id
    and claim_token=p_claim_token
    and status in ('claimed','running');
  get diagnostics n=row_count;
  if n<>1 then return null; end if;

  insert into public.agent_events(job_id,event_type,payload)
  values(p_job_id,p_event_type,coalesce(p_payload,'{}'::jsonb));

  v_event_id := currval(pg_get_serial_sequence('public.agent_events','id'));
  return v_event_id;
end;
$function$;

revoke all on function public.record_agent_event(uuid,text,uuid,text,jsonb,integer)
  from public,anon,authenticated;
grant execute on function public.record_agent_event(uuid,text,uuid,text,jsonb,integer)
  to service_role;
grant execute on function public.record_agent_event(uuid,text,uuid,text,jsonb,integer)
  to anon;

drop function if exists private.antigravity_bridge_auth_ok();
drop table if exists private.antigravity_bridge_auth;
