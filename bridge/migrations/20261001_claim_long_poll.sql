-- 20261001_claim_long_poll.sql
-- Server-side claim wait to reduce idle Supabase HTTP requests.

begin;

create or replace function public.claim_agent_job_wait(
  p_worker_id text,
  p_lease_seconds integer default 180,
  p_timeout_seconds integer default 25,
  p_poll_interval_ms integer default 1000
) returns setof public.agent_jobs
language plpgsql
security invoker
set search_path=public
as $$
declare
  v_deadline timestamptz;
  v_sleep double precision;
begin
  if p_worker_id is null or btrim(p_worker_id)='' then
    raise exception 'worker_id_required';
  end if;
  if p_lease_seconds<30 or p_lease_seconds>900 then
    raise exception 'invalid_lease_seconds';
  end if;
  p_timeout_seconds := least(greatest(coalesce(p_timeout_seconds,25),0),30);
  p_poll_interval_ms := least(greatest(coalesce(p_poll_interval_ms,1000),100),5000);
  v_deadline := clock_timestamp()+make_interval(secs=>p_timeout_seconds);
  v_sleep := p_poll_interval_ms::double precision/1000.0;

  loop
    return query
    with candidate as (
      select id from public.agent_jobs
      where status='pending'
      order by created_at,id
      for update skip locked
      limit 1
    )
    update public.agent_jobs j
    set status='claimed',worker_id=p_worker_id,claim_token=gen_random_uuid(),
        attempts=j.attempts+1,heartbeat_at=now(),
        lease_expires_at=now()+make_interval(secs=>p_lease_seconds),
        updated_at=now(),error=null
    from candidate c where j.id=c.id
    returning j.*;

    if found then return; end if;
    if p_timeout_seconds=0 or clock_timestamp()>=v_deadline then return; end if;
    perform pg_sleep(least(v_sleep,greatest(0.0,extract(epoch from (v_deadline-clock_timestamp())))));
  end loop;
end;
$$;

revoke all on function public.claim_agent_job_wait(text,integer,integer,integer)
  from public,anon,authenticated;
grant execute on function public.claim_agent_job_wait(text,integer,integer,integer)
  to service_role;

commit;
