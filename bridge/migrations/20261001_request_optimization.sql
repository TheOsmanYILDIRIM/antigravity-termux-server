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
grant execute on function public.record_agent_event(uuid,text,uuid,text,jsonb,integer) to anon;

create or replace function private.wait_agent_job(
  p_job_id pg_catalog.uuid,
  p_after_seq pg_catalog.bigint,
  p_timeout_seconds pg_catalog.integer default 20,
  p_poll_interval_ms pg_catalog.integer default 500
) returns pg_catalog.jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_timeout_seconds pg_catalog.integer;
  v_poll_interval_ms pg_catalog.integer;
  v_deadline pg_catalog.timestamptz;
  v_job record;
  v_event record;
  v_status pg_catalog.text;
  v_terminal pg_catalog.boolean;
  v_ready pg_catalog.boolean;
  v_response_text pg_catalog.text;
  v_conversation_id pg_catalog.text;
  v_error pg_catalog.jsonb;
  v_bot_message pg_catalog.jsonb;
  v_subagents pg_catalog.jsonb;
  v_tasks pg_catalog.jsonb;
  v_progress_seq pg_catalog.bigint;
  v_progress_text pg_catalog.text;
  v_progress_event_type pg_catalog.text;
  v_tool_name pg_catalog.text;
  v_tool_state pg_catalog.text;
  v_changed pg_catalog.boolean;
  v_sleep_seconds pg_catalog.double precision;
begin
  if p_job_id is null then
    return pg_catalog.jsonb_build_object(
      'error', 'job_id_required',
      'found', false,
      'status', null,
      'kind', 'progress',
      'timed_out', false,
      'terminal', false,
      'ready', false,
      'changed', false,
      'progress_seq', 0,
      'progress_text', null,
      'progress_event_type', null,
      'tool_name', null,
      'tool_state', null
    );
  end if;

  v_timeout_seconds := pg_catalog.least(pg_catalog.greatest(pg_catalog.coalesce(p_timeout_seconds, 20), 0), 30);
  v_poll_interval_ms := pg_catalog.least(pg_catalog.greatest(pg_catalog.coalesce(p_poll_interval_ms, 500), 100), 5000);
  v_deadline := pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => v_timeout_seconds);
  v_sleep_seconds := v_poll_interval_ms::pg_catalog.double precision / 1000.0;

  loop
    select
      j.id,
      j.status,
      j.conversation_id as job_conversation_id,
      j.worker_id,
      j.attempts,
      j.heartbeat_at,
      j.lease_expires_at,
      j.started_at,
      j.completed_at,
      j.error,
      j.created_at,
      j.updated_at,
      r.conversation_id as result_conversation_id,
      r.response_text,
      r.bot_message,
      r.subagents,
      r.tasks
    into v_job
    from public.agent_jobs j
    left join public.agent_results r on r.job_id = j.id
    where j.id = p_job_id;

    if not found then
      return pg_catalog.jsonb_build_object(
        'job_id', p_job_id,
        'found', false,
        'status', null,
        'kind', 'progress',
        'timed_out', false,
        'terminal', false,
        'ready', false,
        'changed', false,
        'progress_seq', 0,
        'progress_text', null,
        'progress_event_type', null,
        'tool_name', null,
        'tool_state', null
      );
    end if;

    v_status := v_job.status;
    v_terminal := v_status in ('completed', 'failed', 'cancelled');
    v_response_text := pg_catalog.coalesce(v_job.response_text, '');
    v_conversation_id := pg_catalog.coalesce(pg_catalog.nullif(v_job.result_conversation_id, ''), v_job.job_conversation_id);
    v_error := v_job.error;
    v_bot_message := v_job.bot_message;
    v_subagents := pg_catalog.coalesce(v_job.subagents, '[]'::pg_catalog.jsonb);
    v_tasks := pg_catalog.coalesce(v_job.tasks, '[]'::pg_catalog.jsonb);

    select
      e.id,
      e.event_type,
      e.payload
    into v_event
    from public.agent_events e
    where e.job_id = p_job_id
    order by e.id desc
    limit 1;

    if v_event.id is not null then
      v_progress_seq := v_event.id;
      v_progress_event_type := v_event.event_type;
      v_tool_name := pg_catalog.nullif(coalesce(v_event.payload->'tool'->>'name', v_event.payload->>'tool_name', v_event.payload->>'toolName'), '');
      v_tool_state := pg_catalog.nullif(coalesce(v_event.payload->'tool'->>'state', v_event.payload->>'tool_state', v_event.payload->>'toolState'), '');
      v_progress_text := pg_catalog.coalesce(
        pg_catalog.nullif(v_event.payload->>'toolAction', ''),
        pg_catalog.nullif(v_event.payload->>'toolSummary', ''),
        pg_catalog.nullif(v_event.payload->>'message', ''),
        pg_catalog.nullif(v_event.payload->>'status', ''),
        pg_catalog.nullif(v_event.payload->>'summary', ''),
        case
          when v_tool_name is not null and v_tool_state is not null then pg_catalog.concat_ws(' ', v_tool_name, v_tool_state)
          when v_tool_name is not null then v_tool_name
          else null
        end,
        pg_catalog.nullif(v_event.event_type, '')
      );
    else
      v_progress_seq := 0;
      v_progress_text := null;
      v_progress_event_type := null;
      v_tool_name := null;
      v_tool_state := null;
    end if;

    if v_status = 'completed' then
      v_ready := (
        pg_catalog.length(pg_catalog.btrim(v_response_text)) > 0
        and v_conversation_id is not null
        and pg_catalog.length(pg_catalog.btrim(v_conversation_id)) > 0
        and v_error is null
      );
    elsif v_terminal then
      v_ready := true;
    else
      v_ready := false;
    end if;

    v_changed := p_after_seq is null or (v_progress_seq > p_after_seq);

    if v_terminal then
      return pg_catalog.jsonb_build_object(
        'job_id', v_job.id,
        'found', true,
        'status', v_status,
        'kind', 'final',
        'terminal', true,
        'ready', v_ready,
        'timed_out', false,
        'changed', true,
        'conversation_id', v_conversation_id,
        'response_text', v_response_text,
        'error', v_error,
        'bot_message', v_bot_message,
        'subagents', v_subagents,
        'tasks', v_tasks,
        'worker_id', v_job.worker_id,
        'attempts', v_job.attempts,
        'heartbeat_at', v_job.heartbeat_at,
        'lease_expires_at', v_job.lease_expires_at,
        'started_at', v_job.started_at,
        'completed_at', v_job.completed_at,
        'progress_seq', v_progress_seq,
        'progress_text', v_progress_text,
        'progress_event_type', v_progress_event_type,
        'tool_name', v_tool_name,
        'tool_state', v_tool_state
      );
    end if;

    if v_changed then
      return pg_catalog.jsonb_build_object(
        'job_id', v_job.id,
        'found', true,
        'status', v_status,
        'kind', 'progress',
        'terminal', false,
        'ready', false,
        'timed_out', false,
        'changed', true,
        'conversation_id', v_conversation_id,
        'response_text', v_response_text,
        'error', v_error,
        'bot_message', v_bot_message,
        'subagents', v_subagents,
        'tasks', v_tasks,
        'worker_id', v_job.worker_id,
        'attempts', v_job.attempts,
        'heartbeat_at', v_job.heartbeat_at,
        'lease_expires_at', v_job.lease_expires_at,
        'started_at', v_job.started_at,
        'completed_at', v_job.completed_at,
        'progress_seq', v_progress_seq,
        'progress_text', v_progress_text,
        'progress_event_type', v_progress_event_type,
        'tool_name', v_tool_name,
        'tool_state', v_tool_state
      );
    end if;

    if v_timeout_seconds = 0 or pg_catalog.clock_timestamp() >= v_deadline then
      return pg_catalog.jsonb_build_object(
        'job_id', v_job.id,
        'found', true,
        'status', v_status,
        'kind', 'progress',
        'terminal', false,
        'ready', false,
        'timed_out', (v_timeout_seconds > 0),
        'changed', false,
        'conversation_id', v_conversation_id,
        'response_text', v_response_text,
        'error', v_error,
        'bot_message', v_bot_message,
        'subagents', v_subagents,
        'tasks', v_tasks,
        'worker_id', v_job.worker_id,
        'attempts', v_job.attempts,
        'heartbeat_at', v_job.heartbeat_at,
        'lease_expires_at', v_job.lease_expires_at,
        'started_at', v_job.started_at,
        'completed_at', v_job.completed_at,
        'progress_seq', v_progress_seq,
        'progress_text', v_progress_text,
        'progress_event_type', v_progress_event_type,
        'tool_name', v_tool_name,
        'tool_state', v_tool_state
      );
    end if;

    perform pg_catalog.pg_sleep(least(
      v_sleep_seconds,
      greatest(0.0, extract(epoch from (v_deadline - pg_catalog.clock_timestamp())))
    ));
  end loop;
end;
$function$;

revoke all on function private.wait_agent_job(pg_catalog.uuid, pg_catalog.bigint, pg_catalog.integer, pg_catalog.integer) from public, anon, authenticated;
grant execute on function private.wait_agent_job(pg_catalog.uuid, pg_catalog.bigint, pg_catalog.integer, pg_catalog.integer) to service_role;

commit;
