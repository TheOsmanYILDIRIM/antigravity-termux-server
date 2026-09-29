-- Antigravity ChatGPT Agent Bridge Migration
-- Function: private.wait_agent_job(uuid, integer, integer)
-- Rationale: Closes the polling race window by allowing bounded in-database waiting
-- for terminal status & canonical response_text.
-- Security: Defined as SECURITY INVOKER with empty search_path, fully-qualified
-- catalog references, and restricted to service_role/internal operator execution.

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
  v_status pg_catalog.text;
  v_terminal pg_catalog.boolean;
  v_ready pg_catalog.boolean;
  v_response_text pg_catalog.text;
  v_conversation_id pg_catalog.text;
  v_error pg_catalog.jsonb;
  v_bot_message pg_catalog.jsonb;
  v_subagents pg_catalog.jsonb;
  v_tasks pg_catalog.jsonb;
begin
  if p_job_id is null then
    return pg_catalog.jsonb_build_object(
      'error', 'job_id_required',
      'found', false,
      'timed_out', false,
      'terminal', false,
      'ready', false
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
        'timed_out', false,
        'terminal', false,
        'ready', false
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

    -- Canonical success contract:
    -- completed + non-empty response_text + durable conversation_id + error null
    v_ready := (
      v_status = 'completed'
      and pg_catalog.length(pg_catalog.btrim(v_response_text)) > 0
      and v_conversation_id is not null
      and pg_catalog.length(pg_catalog.btrim(v_conversation_id)) > 0
      and v_error is null
    );

    if v_terminal then
      return pg_catalog.jsonb_build_object(
        'job_id', v_job.id,
        'found', true,
        'status', v_status,
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
        'completed_at', v_job.completed_at
      );
    end if;

    if pg_catalog.clock_timestamp() >= v_deadline then
      return pg_catalog.jsonb_build_object(
        'job_id', v_job.id,
        'found', true,
        'status', v_status,
        'terminal', false,
        'ready', false,
        'timed_out', true,
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
        'completed_at', v_job.completed_at
      );
    end if;

    perform pg_catalog.pg_sleep(v_poll_interval_ms / 1000.0);
  end loop;
end;
$$;

revoke all on function private.wait_agent_job(pg_catalog.uuid, pg_catalog.integer, pg_catalog.integer) from public, anon, authenticated;
grant execute on function private.wait_agent_job(pg_catalog.uuid, pg_catalog.integer, pg_catalog.integer) to service_role;

commit;
