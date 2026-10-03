-- Re-open a historically premature-terminal job for same-conversation recovery.
create or replace function public.resume_resumable_agent_job(
  p_job_id uuid
) returns jsonb
language plpgsql
security invoker
set search_path=public,private
as $$
declare
  j public.agent_jobs%rowtype;
  r public.agent_results%rowtype;
  v_active boolean;
begin
  select * into j from public.agent_jobs where id=p_job_id for update;
  if not found then
    return jsonb_build_object('ok',false,'error','job_not_found');
  end if;

  if j.status in ('pending','claimed','running') then
    return jsonb_build_object(
      'ok',true,
      'already_active',true,
      'job_id',j.id,
      'status',j.status,
      'conversation_id',j.conversation_id
    );
  end if;

  select * into r from public.agent_results where job_id=j.id;
  v_active := private.agent_snapshot_has_active(
    r.bot_message,
    coalesce(r.subagents,'[]'::jsonb),
    coalesce(r.tasks,'[]'::jsonb)
  );

  if j.status <> 'completed' or not coalesce(v_active,false) then
    return jsonb_build_object('ok',false,'error','job_not_resumable','status',j.status);
  end if;

  if j.conversation_id is null or btrim(j.conversation_id)='' then
    return jsonb_build_object('ok',false,'error','missing_conversation_id');
  end if;
  if j.worker_id is null or btrim(j.worker_id)='' or j.claim_token is null then
    return jsonb_build_object('ok',false,'error','missing_recovery_ownership');
  end if;

  update public.agent_jobs
  set status='running',
      completed_at=null,
      error=null,
      lease_expires_at=now()-interval '1 second',
      updated_at=now()
  where id=j.id;

  perform private.refresh_agent_resume_cache(
    j.id,
    j.conversation_id,
    coalesce(r.response_text,''),
    r.bot_message,
    coalesce(r.subagents,'[]'::jsonb),
    coalesce(r.tasks,'[]'::jsonb),
    'resume'
  );

  return jsonb_build_object(
    'ok',true,
    'already_active',false,
    'recovery_armed',true,
    'job_id',j.id,
    'status','running',
    'conversation_id',j.conversation_id,
    'worker_id',j.worker_id,
    'replayed_prompt',false
  );
end;
$$;

revoke all on function public.resume_resumable_agent_job(uuid) from public,authenticated;
grant execute on function public.resume_resumable_agent_job(uuid) to anon,service_role;
