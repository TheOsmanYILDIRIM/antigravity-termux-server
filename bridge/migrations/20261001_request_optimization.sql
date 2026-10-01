-- 20261001_request_optimization.sql
-- Cursor-aware waits and activity-coupled heartbeat.

begin;

create or replace function public.record_agent_event(
  p_job_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_event_type text,
  p_payload jsonb default '{}'::jsonb,
  p_lease_seconds integer default 180
) returns bigint
language plpgsql
security invoker
set search_path=public
as $$
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
  values(p_job_id,p_event_type,coalesce(p_payload,'{}'::jsonb))
  returning id into v_event_id;

  return v_event_id;
end;
$$;

revoke all on function public.record_agent_event(uuid,text,uuid,text,jsonb,integer) from public,anon,authenticated;
grant execute on function public.record_agent_event(uuid,text,uuid,text,jsonb,integer) to service_role;

create or replace function private.wait_agent_job(
  p_job_id uuid,
  p_after_seq bigint,
  p_timeout_seconds integer default 20,
  p_poll_interval_ms integer default 500
) returns jsonb
language plpgsql
set search_path to ''
as $function$
declare
  v_started_at timestamptz := pg_catalog.clock_timestamp();
  v_deadline timestamptz;
  v_status text;
  v_job_conversation_id text;
  v_result_conversation_id text;
  v_response_text text;
  v_error jsonb;
  v_heartbeat_at timestamptz;
  v_completed_at timestamptz;
  v_sleep_seconds double precision;
  v_progress_seq bigint;
  v_event_type text;
  v_event_payload jsonb;
  v_progress_text text;
  v_tool_name text;
  v_tool_state text;
  v_changed boolean;
begin
  if p_job_id is null then raise exception 'p_job_id is required'; end if;
  if p_timeout_seconds < 0 or p_timeout_seconds > 30 then
    raise exception 'p_timeout_seconds must be between 0 and 30';
  end if;
  if p_poll_interval_ms < 100 or p_poll_interval_ms > 5000 then
    raise exception 'p_poll_interval_ms must be between 100 and 5000';
  end if;

  v_deadline := v_started_at + pg_catalog.make_interval(secs => p_timeout_seconds);
  v_sleep_seconds := p_poll_interval_ms::double precision / 1000.0;

  loop
    select j.status,j.conversation_id,j.error,j.heartbeat_at,j.completed_at,
           r.conversation_id,r.response_text
    into v_status,v_job_conversation_id,v_error,v_heartbeat_at,v_completed_at,
         v_result_conversation_id,v_response_text
    from public.agent_jobs j
    left join public.agent_results r on r.job_id=j.id
    where j.id=p_job_id;

    if not found then
      return pg_catalog.jsonb_build_object(
        'kind','final','job_id',p_job_id,'status','not_found','terminal',true,
        'ready',false,'timed_out',false,'changed',true,
        'progress_seq',null,'progress_event_type',null,'tool_name',null,'tool_state',null
      );
    end if;

    select e.id,e.event_type,e.payload
    into v_progress_seq,v_event_type,v_event_payload
    from public.agent_events e
    where e.job_id=p_job_id
    order by e.id desc limit 1;

    v_tool_name := nullif(v_event_payload->'tool'->>'name','');
    v_tool_state := nullif(v_event_payload->'tool'->>'state','');
    v_progress_text := case
      when v_event_type='tool_update' then pg_catalog.concat_ws(' ','tool',v_tool_name,v_tool_state)
      when v_event_type is not null then v_event_type
      else null
    end;
    v_changed := p_after_seq is null
      or (v_progress_seq is not null and v_progress_seq > p_after_seq);

    if v_status in ('completed','failed','cancelled') then
      return pg_catalog.jsonb_build_object(
        'kind','final','job_id',p_job_id,'status',v_status,'terminal',true,
        'ready',(v_status='completed' and v_error is null
          and coalesce(pg_catalog.length(pg_catalog.btrim(v_response_text)),0)>0
          and coalesce(v_result_conversation_id,v_job_conversation_id) is not null),
        'timed_out',false,'changed',true,
        'conversation_id',coalesce(v_result_conversation_id,v_job_conversation_id),
        'response_text',v_response_text,'error',v_error,
        'heartbeat_at',v_heartbeat_at,'completed_at',v_completed_at,
        'progress_seq',v_progress_seq,'progress_text',v_progress_text,
        'progress_event_type',v_event_type,'tool_name',v_tool_name,'tool_state',v_tool_state
      );
    end if;

    if v_changed then
      return pg_catalog.jsonb_build_object(
        'kind','progress','job_id',p_job_id,'status',v_status,'terminal',false,
        'ready',false,'timed_out',false,'changed',true,
        'conversation_id',v_job_conversation_id,'response_text',v_response_text,'error',v_error,
        'heartbeat_at',v_heartbeat_at,'completed_at',null,
        'progress_seq',v_progress_seq,'progress_text',v_progress_text,
        'progress_event_type',v_event_type,'tool_name',v_tool_name,'tool_state',v_tool_state
      );
    end if;

    if p_timeout_seconds=0 or pg_catalog.clock_timestamp()>=v_deadline then
      return pg_catalog.jsonb_build_object(
        'kind','progress','job_id',p_job_id,'status',v_status,'terminal',false,
        'ready',false,'timed_out',(p_timeout_seconds>0),'changed',false,
        'conversation_id',v_job_conversation_id,'response_text',v_response_text,'error',v_error,
        'heartbeat_at',v_heartbeat_at,'completed_at',null,
        'progress_seq',v_progress_seq,'progress_text',v_progress_text,
        'progress_event_type',v_event_type,'tool_name',v_tool_name,'tool_state',v_tool_state
      );
    end if;

    perform pg_catalog.pg_sleep(least(
      v_sleep_seconds,
      greatest(0.0,extract(epoch from (v_deadline-pg_catalog.clock_timestamp())))
    ));
  end loop;
end;
$function$;

revoke all on function private.wait_agent_job(uuid,bigint,integer,integer) from public,anon,authenticated;
grant execute on function private.wait_agent_job(uuid,bigint,integer,integer) to service_role;

commit;
