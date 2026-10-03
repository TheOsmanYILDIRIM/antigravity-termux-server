-- Durable cross-chat resume + DB-level terminal-state guard.
-- Prevents a ChatGPT turn ending from orphaning the logical AGY job.

begin;

create or replace function private.agent_json_array_has_active(p_items jsonb)
returns boolean
language sql
immutable
set search_path=''
as $$
  select coalesce(bool_or(
    lower(coalesce(x->>'status', x->>'state', '')) in
      ('pending','running','claimed','queued','in_progress','waiting','waiting_for_message','waiting_for_input','waiting_for_dependents')
  ), false)
  from jsonb_array_elements(
    case when jsonb_typeof(coalesce(p_items,'[]'::jsonb))='array'
      then coalesce(p_items,'[]'::jsonb)
      else '[]'::jsonb
    end
  ) as x;
$$;

create or replace function private.agent_snapshot_has_active(
  p_bot_message jsonb,
  p_subagents jsonb,
  p_tasks jsonb
) returns boolean
language sql
immutable
set search_path=''
as $$
  select
    private.agent_json_array_has_active(p_tasks)
    or private.agent_json_array_has_active(p_subagents)
    or private.agent_json_array_has_active(coalesce(p_bot_message->'tasks','[]'::jsonb))
    or private.agent_json_array_has_active(coalesce(p_bot_message->'subagents','[]'::jsonb))
    or private.agent_json_array_has_active(coalesce(p_bot_message->'tools','[]'::jsonb));
$$;

revoke all on function private.agent_json_array_has_active(jsonb) from public,anon,authenticated;
revoke all on function private.agent_snapshot_has_active(jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function private.agent_json_array_has_active(jsonb) to anon,service_role;
grant execute on function private.agent_snapshot_has_active(jsonb,jsonb,jsonb) to anon,service_role;

create or replace function public.complete_agent_job(
  p_job_id uuid,p_worker_id text,p_claim_token uuid,p_conversation_id text,p_response_text text,
  p_bot_message jsonb default null,p_subagents jsonb default '[]'::jsonb,p_tasks jsonb default '[]'::jsonb
) returns boolean
language plpgsql
security invoker
set search_path=public,private
as $$
declare
  n integer;
begin
  -- Persist the freshest snapshot first. If AGY still owns background work,
  -- keep the job non-terminal and let relay recovery continue the SAME job.
  if private.agent_snapshot_has_active(p_bot_message,p_subagents,p_tasks) then
    update public.agent_jobs
    set conversation_id=coalesce(nullif(p_conversation_id,''),conversation_id),
        status='running',
        heartbeat_at=now(),
        lease_expires_at=greatest(coalesce(lease_expires_at,now()),now()+interval '180 seconds'),
        updated_at=now(),
        completed_at=null,
        error=null
    where id=p_job_id and worker_id=p_worker_id and claim_token=p_claim_token
      and status in ('claimed','running');

    get diagnostics n=row_count;
    if n<>1 then return false; end if;

    perform private.write_agent_result(
      p_job_id,p_conversation_id,p_response_text,p_bot_message,p_subagents,p_tasks
    );
    return false;
  end if;

  update public.agent_jobs
  set status='completed',
      conversation_id=coalesce(nullif(p_conversation_id,''),conversation_id),
      completed_at=now(),
      heartbeat_at=now(),
      lease_expires_at=null,
      updated_at=now(),
      error=null
  where id=p_job_id and worker_id=p_worker_id and claim_token=p_claim_token
    and status in ('claimed','running');

  get diagnostics n=row_count;
  if n<>1 then return false; end if;

  perform private.write_agent_result(
    p_job_id,p_conversation_id,p_response_text,p_bot_message,p_subagents,p_tasks
  );
  return true;
end;
$$;

revoke all on function public.complete_agent_job(uuid,text,uuid,text,text,jsonb,jsonb,jsonb)
  from public,anon,authenticated;
grant execute on function public.complete_agent_job(uuid,text,uuid,text,text,jsonb,jsonb,jsonb)
  to anon,service_role;

create or replace function public.find_resumable_agent_job(
  p_requested_by text default 'chatgpt',
  p_resume_key text default null
) returns jsonb
language plpgsql
security invoker
set search_path=public,private
as $$
declare
  v record;
begin
  select
    j.id,
    j.idempotency_key,
    j.requested_by,
    j.status,
    j.request,
    j.conversation_id,
    j.worker_id,
    j.attempts,
    j.heartbeat_at,
    j.lease_expires_at,
    j.started_at,
    j.completed_at,
    j.created_at,
    j.updated_at,
    j.error,
    r.response_text,
    r.bot_message,
    coalesce(r.subagents,'[]'::jsonb) as subagents,
    coalesce(r.tasks,'[]'::jsonb) as tasks,
    private.agent_snapshot_has_active(
      r.bot_message,coalesce(r.subagents,'[]'::jsonb),coalesce(r.tasks,'[]'::jsonb)
    ) as snapshot_active
  into v
  from public.agent_jobs j
  left join public.agent_results r on r.job_id=j.id
  where j.requested_by=coalesce(nullif(p_requested_by,''),'chatgpt')
    and (
      p_resume_key is null
      or j.idempotency_key=p_resume_key
      or j.request->>'resumeKey'=p_resume_key
    )
    and (
      j.status in ('pending','claimed','running')
      or (
        j.status='completed'
        and private.agent_snapshot_has_active(
          r.bot_message,coalesce(r.subagents,'[]'::jsonb),coalesce(r.tasks,'[]'::jsonb)
        )
      )
    )
  order by
    case
      when private.agent_snapshot_has_active(
        r.bot_message,coalesce(r.subagents,'[]'::jsonb),coalesce(r.tasks,'[]'::jsonb)
      ) then 0
      when j.status in ('pending','claimed','running') then 1
      else 2
    end,
    j.updated_at desc,
    j.created_at desc
  limit 1;

  if not found then
    return jsonb_build_object('found',false);
  end if;

  return jsonb_build_object(
    'found',true,
    'job_id',v.id,
    'idempotency_key',v.idempotency_key,
    'resume_key',coalesce(v.request->>'resumeKey',v.idempotency_key),
    'resume_title',coalesce(v.request->>'resumeTitle',left(v.request->>'prompt',160)),
    'status',v.status,
    'terminal',v.status in ('completed','failed','cancelled'),
    'snapshot_active',v.snapshot_active,
    'conversation_id',v.conversation_id,
    'worker_id',v.worker_id,
    'attempts',v.attempts,
    'heartbeat_at',v.heartbeat_at,
    'lease_expires_at',v.lease_expires_at,
    'started_at',v.started_at,
    'completed_at',v.completed_at,
    'updated_at',v.updated_at,
    'error',v.error,
    'response_text',coalesce(v.response_text,''),
    'bot_message',v.bot_message,
    'subagents',v.subagents,
    'tasks',v.tasks
  );
end;
$$;

revoke all on function public.find_resumable_agent_job(text,text) from public,authenticated;
grant execute on function public.find_resumable_agent_job(text,text) to anon,service_role;

commit;
