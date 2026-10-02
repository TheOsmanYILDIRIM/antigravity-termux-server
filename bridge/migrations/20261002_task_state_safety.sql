-- 20261002_task_state_safety.sql
-- Atomic progress persistence and safe background task terminal state management.

begin;

create or replace function public.save_agent_job_progress(
  p_job_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_conversation_id text,
  p_response_text text,
  p_bot_message jsonb default null,
  p_subagents jsonb default '[]'::jsonb,
  p_tasks jsonb default '[]'::jsonb,
  p_lease_seconds integer default 180
) returns boolean
language plpgsql
security invoker
set search_path = public, private
as $$
declare
  n integer;
begin
  if p_lease_seconds < 30 or p_lease_seconds > 900 then
    raise exception 'invalid_lease_seconds';
  end if;

  update public.agent_jobs
  set conversation_id = coalesce(nullif(p_conversation_id, ''), conversation_id),
      heartbeat_at = now(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      updated_at = now()
  where id = p_job_id
    and worker_id = p_worker_id
    and claim_token = p_claim_token
    and status in ('claimed', 'running');

  get diagnostics n = row_count;
  if n <> 1 then return false; end if;

  perform private.write_agent_result(
    p_job_id,
    p_conversation_id,
    p_response_text,
    p_bot_message,
    p_subagents,
    p_tasks
  );

  return true;
end;
$$;

revoke all on function public.save_agent_job_progress(uuid,text,uuid,text,text,jsonb,jsonb,jsonb,integer) from public,anon,authenticated;
grant execute on function public.save_agent_job_progress(uuid,text,uuid,text,text,jsonb,jsonb,jsonb,integer) to service_role;
grant execute on function public.save_agent_job_progress(uuid,text,uuid,text,text,jsonb,jsonb,jsonb,integer) to anon;

commit;
