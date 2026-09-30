-- Antigravity ChatGPT Agent Bridge Migration
-- Function: private.wait_agent_job(uuid, integer, integer)
-- Rationale: Unambiguous progress (kind=progress) vs terminal (kind=final) response contract
-- with monotonic progress_seq and safe progress_text while maintaining strict backward compatibility.
-- Security: SECURITY INVOKER with empty search_path='', fully qualified types/functions,
-- restricted to service_role.

begin;

create or replace function private.wait_agent_job(
  p_job_id pg_catalog.uuid,
  p_timeout_seconds pg_catalog.integer default 20,
  p_poll_interval_ms pg_catalog.integer default 500
) returns pg_catalog.jsonb
language plpgsql
security invoker
set search_path = ''
as $$
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
      'progress_seq', 0,
      'progress_text', null
    );
  end if;

  -- Clamp timeout: 0 to 30 seconds (0 allows instant snapshot check)
  v_timeout_seconds := pg_catalog.least(pg_catalog.greatest(pg_catalog.coalesce(p_timeout_seconds, 20), 0), 30);
  -- Clamp poll interval: 100ms to 5000ms
  v_poll_interval_ms := pg_catalog.least(pg_catalog.greatest(pg_catalog.coalesce(p_poll_interval_ms, 500), 100), 5000);
  v_deadline := pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => v_timeout_seconds);

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
        'progress_seq', 0,
        'progress_text', null
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

    -- Fetch latest progress event if available
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
      v_progress_text := pg_catalog.coalesce(
        pg_catalog.nullif(v_event.payload->>'toolAction', ''),
        pg_catalog.nullif(v_event.payload->>'toolSummary', ''),
        pg_catalog.nullif(v_event.payload->>'message', ''),
        pg_catalog.nullif(v_event.payload->>'status', ''),
        pg_catalog.nullif(v_event.payload->>'summary', ''),
        pg_catalog.nullif(v_event.event_type, '')
      );
    else
      v_progress_seq := 0;
      v_progress_text := null;
    end if;

    -- Canonical ready evaluation:
    -- completed: ready when non-empty response_text, durable conversation_id, and error null
    -- failed/cancelled: ready = true (terminal result ready to inspect)
    -- non-terminal: ready = false
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

    if v_terminal then
      return pg_catalog.jsonb_build_object(
        'job_id', v_job.id,
        'found', true,
        'status', v_status,
        'kind', 'final',
        'terminal', true,
        'ready', v_ready,
        'timed_out', false,
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
        'progress_text', v_progress_text
      );
    end if;

    if pg_catalog.clock_timestamp() >= v_deadline then
      return pg_catalog.jsonb_build_object(
        'job_id', v_job.id,
        'found', true,
        'status', v_status,
        'kind', 'progress',
        'terminal', false,
        'ready', false,
        'timed_out', (v_timeout_seconds > 0),
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
        'progress_text', v_progress_text
      );
    end if;

    perform pg_catalog.pg_sleep(v_poll_interval_ms / 1000.0);
  end loop;
end;
$$;

revoke all on function private.wait_agent_job(pg_catalog.uuid, pg_catalog.integer, pg_catalog.integer) from public, anon, authenticated;
grant execute on function private.wait_agent_job(pg_catalog.uuid, pg_catalog.integer, pg_catalog.integer) to service_role;

commit;
