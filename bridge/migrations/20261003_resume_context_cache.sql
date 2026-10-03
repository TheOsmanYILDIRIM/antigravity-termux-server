-- Supabase-backed compact context cache for cross-chat AGY resume.
begin;

create table if not exists public.agent_resume_cache (
  job_id uuid primary key references public.agent_jobs(id) on delete cascade,
  resume_key text not null,
  resume_title text not null default '',
  goal text not null default '',
  summary text not null default '',
  next_step text not null default '',
  conversation_id text,
  status text not null default '',
  context jsonb not null default '{}'::jsonb,
  source text not null default 'bridge',
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_resume_cache_context_object check (jsonb_typeof(context)='object')
);

create index if not exists agent_resume_cache_resume_key_idx
  on public.agent_resume_cache(resume_key,updated_at desc);
create index if not exists agent_resume_cache_updated_idx
  on public.agent_resume_cache(updated_at desc);

alter table public.agent_resume_cache enable row level security;
revoke all on table public.agent_resume_cache from anon,authenticated;
grant select,insert,update,delete on table public.agent_resume_cache to service_role;
grant select,insert,update on table public.agent_resume_cache to anon;

drop policy if exists bridge_anon_resume_cache_select on public.agent_resume_cache;
drop policy if exists bridge_anon_resume_cache_insert on public.agent_resume_cache;
drop policy if exists bridge_anon_resume_cache_update on public.agent_resume_cache;
create policy bridge_anon_resume_cache_select on public.agent_resume_cache
  for select to anon using (true);
create policy bridge_anon_resume_cache_insert on public.agent_resume_cache
  for insert to anon with check (true);
create policy bridge_anon_resume_cache_update on public.agent_resume_cache
  for update to anon using (true) with check (true);

create or replace function private.refresh_agent_resume_cache(
  p_job_id uuid,
  p_conversation_id text default null,
  p_response_text text default '',
  p_bot_message jsonb default null,
  p_subagents jsonb default '[]'::jsonb,
  p_tasks jsonb default '[]'::jsonb,
  p_source text default 'bridge'
) returns void
language plpgsql
security definer
set search_path=private,public
as $$
declare
  j public.agent_jobs%rowtype;
  v_key text;
  v_title text;
  v_goal text;
  v_summary text;
  v_next text;
  v_active_tasks jsonb;
  v_active_subagents jsonb;
  v_context jsonb;
begin
  select * into j from public.agent_jobs where id=p_job_id;
  if not found then return; end if;

  v_key := coalesce(nullif(j.request->>'resumeKey',''),j.idempotency_key);
  v_title := coalesce(
    nullif(j.request->>'resumeTitle',''),
    nullif(left(regexp_replace(coalesce(j.request->>'prompt',''),'[[:space:]]+',' ','g'),180),''),
    v_key
  );
  v_goal := coalesce(
    nullif(j.request->>'resumeGoal',''),
    nullif(j.request->>'goal',''),
    left(regexp_replace(coalesce(j.request->>'prompt',''),'[[:space:]]+',' ','g'),1200)
  );
  v_summary := coalesce(
    nullif(j.request->>'resumeSummary',''),
    nullif(left(regexp_replace(coalesce(p_response_text,''),'[[:space:]]+',' ','g'),2400),''),
    nullif(left(regexp_replace(coalesce(j.request->>'prompt',''),'[[:space:]]+',' ','g'),1200),''),
    ''
  );

  select coalesce(jsonb_agg(x),'[]'::jsonb)
  into v_active_tasks
  from jsonb_array_elements(
    case when jsonb_typeof(coalesce(p_tasks,'[]'::jsonb))='array' then coalesce(p_tasks,'[]'::jsonb) else '[]'::jsonb end
  ) x
  where lower(coalesce(x->>'status',x->>'state','')) in
    ('pending','running','claimed','queued','in_progress','waiting','waiting_for_message','waiting_for_input','waiting_for_dependents');

  select coalesce(jsonb_agg(x),'[]'::jsonb)
  into v_active_subagents
  from jsonb_array_elements(
    case when jsonb_typeof(coalesce(p_subagents,'[]'::jsonb))='array' then coalesce(p_subagents,'[]'::jsonb) else '[]'::jsonb end
  ) x
  where lower(coalesce(x->>'status',x->>'state','')) in
    ('pending','running','claimed','queued','in_progress','waiting','waiting_for_message','waiting_for_input','waiting_for_dependents');

  v_next := coalesce(
    nullif(j.request->>'nextStep',''),
    nullif(j.request->>'resumeNextStep',''),
    case
      when jsonb_array_length(v_active_tasks)>0 then
        'Continue monitoring active task: '||
        coalesce(v_active_tasks->0->>'name',v_active_tasks->0->>'id','background task')
      when jsonb_array_length(v_active_subagents)>0 then
        'Continue monitoring active subagent: '||
        coalesce(v_active_subagents->0->>'name',v_active_subagents->0->>'id','subagent')
      when j.status in ('pending','claimed','running') then 'Continue the same job without replaying it.'
      else ''
    end
  );

  v_context := jsonb_build_object(
    'jobId',j.id,
    'idempotencyKey',j.idempotency_key,
    'request',j.request,
    'botMessage',p_bot_message,
    'activeTasks',v_active_tasks,
    'activeSubagents',v_active_subagents,
    'allTasks',coalesce(p_tasks,'[]'::jsonb),
    'allSubagents',coalesce(p_subagents,'[]'::jsonb),
    'heartbeatAt',j.heartbeat_at,
    'leaseExpiresAt',j.lease_expires_at,
    'startedAt',j.started_at,
    'completedAt',j.completed_at
  );

  insert into public.agent_resume_cache(
    job_id,resume_key,resume_title,goal,summary,next_step,conversation_id,
    status,context,source,version,created_at,updated_at
  ) values(
    j.id,v_key,v_title,v_goal,v_summary,v_next,
    coalesce(nullif(p_conversation_id,''),j.conversation_id),
    j.status,v_context,coalesce(nullif(p_source,''),'bridge'),1,now(),now()
  )
  on conflict(job_id) do update set
    resume_key=excluded.resume_key,
    resume_title=excluded.resume_title,
    goal=excluded.goal,
    summary=excluded.summary,
    next_step=excluded.next_step,
    conversation_id=excluded.conversation_id,
    status=excluded.status,
    context=excluded.context,
    source=excluded.source,
    version=public.agent_resume_cache.version+1,
    updated_at=now();
end;
$$;

revoke all on function private.refresh_agent_resume_cache(uuid,text,text,jsonb,jsonb,jsonb,text)
  from public,authenticated;
grant execute on function private.refresh_agent_resume_cache(uuid,text,text,jsonb,jsonb,jsonb,text)
  to anon,service_role;

create or replace function public.upsert_agent_resume_context(
  p_job_id uuid,
  p_resume_title text default null,
  p_goal text default null,
  p_summary text default null,
  p_next_step text default null,
  p_context jsonb default '{}'::jsonb,
  p_source text default 'chatgpt'
) returns jsonb
language plpgsql
security invoker
set search_path=public
as $$
declare
  j public.agent_jobs%rowtype;
  c public.agent_resume_cache%rowtype;
begin
  select * into j from public.agent_jobs where id=p_job_id;
  if not found then return jsonb_build_object('ok',false,'error','job_not_found'); end if;
  if jsonb_typeof(coalesce(p_context,'{}'::jsonb))<>'object' then
    return jsonb_build_object('ok',false,'error','context_must_be_object');
  end if;

  insert into public.agent_resume_cache(
    job_id,resume_key,resume_title,goal,summary,next_step,conversation_id,status,
    context,source,version,created_at,updated_at
  ) values(
    j.id,
    coalesce(nullif(j.request->>'resumeKey',''),j.idempotency_key),
    coalesce(nullif(p_resume_title,''),nullif(j.request->>'resumeTitle',''),left(j.request->>'prompt',180),''),
    coalesce(nullif(p_goal,''),nullif(j.request->>'resumeGoal',''),left(j.request->>'prompt',1200),''),
    coalesce(nullif(p_summary,''),''),
    coalesce(nullif(p_next_step,''),''),
    j.conversation_id,
    j.status,
    coalesce(p_context,'{}'::jsonb),
    coalesce(nullif(p_source,''),'chatgpt'),
    1,now(),now()
  )
  on conflict(job_id) do update set
    resume_title=coalesce(nullif(p_resume_title,''),public.agent_resume_cache.resume_title),
    goal=coalesce(nullif(p_goal,''),public.agent_resume_cache.goal),
    summary=coalesce(nullif(p_summary,''),public.agent_resume_cache.summary),
    next_step=coalesce(nullif(p_next_step,''),public.agent_resume_cache.next_step),
    context=public.agent_resume_cache.context||coalesce(p_context,'{}'::jsonb),
    conversation_id=coalesce(j.conversation_id,public.agent_resume_cache.conversation_id),
    status=j.status,
    source=coalesce(nullif(p_source,''),public.agent_resume_cache.source),
    version=public.agent_resume_cache.version+1,
    updated_at=now()
  returning * into c;

  return jsonb_build_object(
    'ok',true,'job_id',c.job_id,'resume_key',c.resume_key,'resume_title',c.resume_title,
    'goal',c.goal,'summary',c.summary,'next_step',c.next_step,'conversation_id',c.conversation_id,
    'status',c.status,'context',c.context,'source',c.source,'version',c.version,'updated_at',c.updated_at
  );
end;
$$;

revoke all on function public.upsert_agent_resume_context(uuid,text,text,text,text,jsonb,text)
  from public,authenticated;
grant execute on function public.upsert_agent_resume_context(uuid,text,text,text,text,jsonb,text)
  to anon,service_role;

create or replace function public.get_agent_resume_context(
  p_job_id uuid default null,
  p_resume_key text default null
) returns jsonb
language plpgsql
security invoker
set search_path=public
as $$
declare
  c public.agent_resume_cache%rowtype;
begin
  select * into c
  from public.agent_resume_cache
  where (p_job_id is not null and job_id=p_job_id)
     or (p_job_id is null and p_resume_key is not null and resume_key=p_resume_key)
  order by updated_at desc
  limit 1;

  if not found then return jsonb_build_object('found',false); end if;
  return jsonb_build_object(
    'found',true,'job_id',c.job_id,'resume_key',c.resume_key,'resume_title',c.resume_title,
    'goal',c.goal,'summary',c.summary,'next_step',c.next_step,'conversation_id',c.conversation_id,
    'status',c.status,'context',c.context,'source',c.source,'version',c.version,'updated_at',c.updated_at
  );
end;
$$;

revoke all on function public.get_agent_resume_context(uuid,text) from public,authenticated;
grant execute on function public.get_agent_resume_context(uuid,text) to anon,service_role;

-- Backfill cache from all existing jobs/results.
select private.refresh_agent_resume_cache(
  j.id,
  coalesce(r.conversation_id,j.conversation_id),
  coalesce(r.response_text,''),
  r.bot_message,
  coalesce(r.subagents,'[]'::jsonb),
  coalesce(r.tasks,'[]'::jsonb),
  'backfill'
)
from public.agent_jobs j
left join public.agent_results r on r.job_id=j.id;

commit;
