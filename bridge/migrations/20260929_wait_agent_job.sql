-- Antigravity ChatGPT Agent Bridge Migration
-- Function: private.wait_agent_job(uuid, integer, integer)
-- Rationale: Closes the polling race window by allowing ChatGPT to perform bounded
-- in-database waiting for terminal status & canonical response_text, eliminating
-- high-frequency client polling and missed completion races.

begin;

create or replace function private.wait_agent_job(
  p_job_id uuid,
  p_timeout_seconds integer default 20,
  p_poll_interval_ms integer default 500
) returns jsonb
language plpgsql
security definer
set search_path = private, public
as $$
declare
  v_timeout_seconds integer;
  v_poll_interval_ms integer;
  v_deadline timestamptz;
  v_job record;
  v_status text;
  v_terminal boolean;
  v_ready boolean;
  v_response_text text;
  v_conversation_id text;
  v_error jsonb;
  v_bot_message jsonb;
  v_subagents jsonb;
  v_tasks jsonb;
begin
  if p_job_id is null then
    return jsonb_build_object(
      'error', 'job_id_required',
      'found', false,
      'timed_out', false,
      'terminal', false,
      'ready', false
    );
  end if;

  -- Clamp timeout: 0 to 30 seconds (0 allows instant snapshot check)
  v_timeout_seconds := least(greatest(coalesce(p_timeout_seconds, 20), 0), 30);
  -- Clamp poll interval: 100ms to 5000ms
  v_poll_interval_ms := least(greatest(coalesce(p_poll_interval_ms, 500), 100), 5000);
  v_deadline := clock_timestamp() + make_interval(secs => v_timeout_seconds);

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
      return jsonb_build_object(
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
    v_response_text := coalesce(v_job.response_text, '');
    v_conversation_id := coalesce(nullif(v_job.result_conversation_id, ''), v_job.job_conversation_id);
    v_error := v_job.error;
    v_bot_message := v_job.bot_message;
    v_subagents := coalesce(v_job.subagents, '[]'::jsonb);
    v_tasks := coalesce(v_job.tasks, '[]'::jsonb);

    -- Canonical success contract:
    -- completed + non-empty response_text + durable conversation_id + error null
    v_ready := (
      v_status = 'completed'
      and length(btrim(v_response_text)) > 0
      and v_conversation_id is not null
      and length(btrim(v_conversation_id)) > 0
      and v_error is null
    );

    if v_terminal then
      return jsonb_build_object(
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

    if clock_timestamp() >= v_deadline then
      return jsonb_build_object(
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

    perform pg_sleep(v_poll_interval_ms / 1000.0);
  end loop;
end;
$$;

grant usage on schema private to anon, service_role;
grant execute on function private.wait_agent_job(uuid, integer, integer) to anon, service_role;

commit;
