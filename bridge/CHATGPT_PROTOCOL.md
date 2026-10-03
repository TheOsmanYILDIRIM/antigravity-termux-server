# ChatGPT ↔ Antigravity Agent Bridge Protocol

This document is the authoritative application-level contract for ChatGPT jobs sent to the dedicated `antigravity-bridge` Supabase project.

ChatGPT-side delegation policy is defined in `skills/chatgpt-agy-subagent/SKILL.md`. That skill defines when ChatGPT should delegate to AGY, the permitted Termux HOME read/search/shell scope, model/effort selection rules, continuation behavior, token-efficiency guidance, and result/error handling.

## Scope

This bridge is independent from Avenox Brain / `avenox-bridge`.

Runtime path:

```text
ChatGPT
  -> Supabase agent_jobs
  -> Termux bridge/relay.js
  -> Antigravity localhost API
  -> AGY CLI
  -> AGY tools / subagents / tasks
  -> agent_results
  -> ChatGPT
```

## Job creation

ChatGPT creates exactly one row in `public.agent_jobs` per logical delegated task.

Required request field:

```json
{
  "prompt": "Task for AGY"
}
```

Supported optional request fields currently consumed by `bridge/relay.js`:

```json
{
  "conversationId": "existing AGY conversation id",
  "model": "model id",
  "effort": "low|medium|high",
  "mode": "plan|accept-edits",
  "useVault": true,
  "autoCompact": true,
  "compactThresholdTokens": 80000,
  "attachments": []
}
```

Do not invent extra execution semantics in ChatGPT. Unknown fields may be stored by Postgres but are not part of this contract unless relay code explicitly consumes them.

Use a stable `idempotency_key` for retries of the same logical request. Do not create a replacement job while an existing job is `claimed` or `running`.

## Lifecycle

Authoritative job states:

```text
pending
  -> claimed
  -> running
  -> completed
             \-> failed
             \-> cancelled
```

- `pending`: available for a relay worker.
- `claimed`: atomically owned by one relay worker and protected by `claim_token`.
- `running`: submitted to or being recovered from AGY.
- `completed`: terminal success. Read `agent_results`.
- `failed`: terminal failure. Read `agent_jobs.error`.
- `cancelled`: terminal cancellation.

`worker_id`, `heartbeat_at`, and `lease_expires_at` are relay-owned fields.

## Correlation

The relay sends the Supabase job UUID as Antigravity `requestId`.

Antigravity returns that `requestId` on correlated SSE events. The relay must ignore unrelated global SSE traffic.

Once AGY assigns a conversation, `conversation_id` is the durable continuation/recovery identifier.

## Results

Only `public.agent_results` is the authoritative success payload.

Fields:

- `job_id`: same UUID as `agent_jobs.id`.
- `conversation_id`: AGY conversation used for continuation/recovery.
- `response_text`: final AGY response.
- `bot_message`: normalized final bot message when available.
- `subagents`: final subagent snapshot.
- `tasks`: final task snapshot.
- `created_at`: result write time.

A `done` event in `agent_events` or `bot_message.state == "done"` is diagnostic evidence of a turn, NOT by itself proof that the job is completed. A job may be completed ONLY when:
1. The final assistant/bot message is done with non-empty response text.
2. No `tasks` or `bot_message.tasks` entry has status `pending`, `running`, `claimed`, `queued`, or `in_progress`.
3. No `subagents` entry has status `pending`, `running`, `claimed`, `queued`, or `in_progress`.
4. No tool invocation is still pending or running (a `manage_task` or `run_command` tool call completing is not equivalent to the background task completing).
5. The underlying AGY conversation/generation is no longer active (`isGenerating == false`).

If a bot response appears while background tasks or subagents still run, the bridge persists it as an intermediate progress response into `agent_results` while keeping `agent_jobs.status = 'running'`. ChatGPT receives intermediate progress snapshots via `private.wait_agent_job` and continues waiting until `kind == 'final'`.

## Recovery and duplicate prevention

- A stale `claimed` job that never started may be requeued using the same job ID.
- A stale `running` job should be recovered via its existing `conversation_id`.
- If a running job has no recoverable conversation ID, do not blindly replay the prompt. Prefer a terminal failure requiring explicit operator action.
- ChatGPT must follow the original job ID until terminal state.
- Never start a second job merely because a poll returned `claimed` or `running`.

## ChatGPT wait and read pattern

### Bounded in-database waiting (`private.wait_agent_job`)

To eliminate high-frequency polling loops and race windows between job completion and subsequent polls, ChatGPT must use the database-side bounded waiting function after enqueue:

```sql
-- Initial bounded wait (or 3-arg overload)
select private.wait_agent_job(
  p_job_id => '<job-id>'::uuid,
  p_timeout_seconds => 20, -- 20-30s bounded wait
  p_poll_interval_ms => 500
);

-- Cursor-aware progress wait (4-arg overload)
select private.wait_agent_job(
  p_job_id => '<job-id>'::uuid,
  p_after_seq => <last_seen_progress_seq>::bigint,
  p_timeout_seconds => 20,
  p_poll_interval_ms => 500
);
```

**Rationale:** Manual high-frequency polling creates needless tool calls and race windows between worker completion and the next ChatGPT poll; database-side bounded waiting closes that gap by holding the connection until terminal state, a new progress event (`progress_seq > p_after_seq`), or deadline.

### Response contract:

The response unambiguously categorizes non-terminal progress vs terminal results while preserving all existing fields for backward compatibility:

- **Non-terminal progress (`kind = 'progress'`, `terminal = false`, `ready = false`):**
  - Returned when the job is still `pending`, `claimed`, or `running`.
  - Includes `job_id`, `status`, `heartbeat_at`, `conversation_id`, `timed_out` (true if the bounded wait expired; false if queried snapshot), `changed` (true if `progress_seq > p_after_seq` or initial fetch; false if long-poll expired with no new events), `progress_seq` (monotonic integer based on `agent_events.id`), `progress_text` (short latest action summary string or null), `progress_event_type`, `tool_name`, `tool_state`.
  - All existing fields (`found`, `worker_id`, `attempts`, `lease_expires_at`, `started_at`, `completed_at`, `error`, `response_text`, `bot_message`, `subagents`, `tasks`) remain present.

- **Terminal completion (`kind = 'final'`, `terminal = true`, `status = 'completed'`, `ready = true`):**
  - Returned immediately when the job has successfully finished.
  - Contains `timed_out = false`, `changed = true`, `response_text`, `conversation_id`, `completed_at`, `heartbeat_at`, `bot_message`, `subagents`, `tasks`, `progress_seq`, `progress_text`.

- **Terminal failure/cancellation (`kind = 'final'`, `terminal = true`, `status in ('failed', 'cancelled')`, `ready = true`):**
  - Returned immediately when the job suffered a terminal failure or cancellation.
  - Contains `timed_out = false`, `changed = true`, `error` (diagnostic failure object), `completed_at`, `heartbeat_at`, `conversation_id`, `response_text`, `progress_seq`, `progress_text`.

- **`timed_out` and `changed` semantics:**
  - `timed_out`: Means **only** that the bounded database-side RPC wait interval elapsed without the job reaching a terminal state. It must **never** be treated as proof that the job is stalled, stalled out, or errored.
  - `changed`: Indicates whether new progress occurred (`true`) or whether the wait interval expired at the same sequence (`false`).
  - Callers must key off `kind`, `terminal`, and `status`, rather than treating `timed_out` as a failure.

- **`progress_seq` & `progress_text` semantics:**
  - `progress_seq`: Monotonic integer sequence matching the latest `agent_events.id` for the job (`0` when no events have yet been recorded).
  - `progress_text`: Exact, non-synthetic short status summary extracted from the latest `agent_events` row (`payload->>'toolAction'`, `payload->>'toolSummary'`, `payload->>'message'`, or `event_type`), or `null` if no event text exists.
  - Structured fields `progress_event_type`, `tool_name`, `tool_state` provide canonical machine-readable progress indicators.

### Operational rules:
- **Prefer cursor-aware bounded wait:** After enqueue, call `private.wait_agent_job(job_id, p_timeout_seconds => 20)`. For subsequent wait cycles, pass the last seen `progress_seq` as `p_after_seq` to avoid redundant snapshot processing.
- **Key off `kind` / `terminal` / `status`:**
  1. `kind == 'progress'` (`terminal == false`): Job is still executing or queued. If `changed == true`, track the new `progress_seq` and optionally surface milestone updates. Re-invoke `private.wait_agent_job(job_id, p_after_seq => last_seq)` for the SAME job ID.
  2. `kind == 'final'` and `status == 'completed'` and `ready == true`: Job succeeded. Stop polling immediately and consume `response_text`.
  3. `kind == 'final'` and `status in ('failed', 'cancelled')`: Job terminated with error. Stop polling immediately and inspect `error` object.
  4. `kind == 'final'` and `status == 'completed'` and `ready == false`: Bridge protocol error (e.g. empty response_text); inspect `agent_jobs` + `agent_results` once.
- **Timeout handling:** If `kind == 'progress'` and `timed_out == true`, call the SAME wait primitive again for the SAME job ID. Do not create a replacement job.
- **Event reading for debugging only:** Read `agent_events` ONLY for debugging (failed job, stale heartbeat, repeated timeout, protocol mismatch), NOT for normal waiting.
- **Interruption snapshot:** If the user interrupts after a delegated job may have completed, first do a zero-time/snapshot wait call (`p_timeout_seconds => 0`) for the existing job before creating any new job.
- **Preserve conversation:** Preserve `conversation_id` for continuation.
- **Job cardinality:** One logical task = one job ID.

### Fallback direct inspection query shape (debug only):

```sql
select
  j.id,
  j.status,
  j.worker_id,
  j.conversation_id,
  j.attempts,
  j.heartbeat_at,
  j.lease_expires_at,
  j.completed_at,
  j.error,
  r.response_text,
  r.subagents,
  r.tasks
from public.agent_jobs j
left join public.agent_results r on r.job_id = j.id
where j.id = '<job-id>'::uuid;
```

Do not use a broad queue scan when the active job ID is already known.

## Continuation

To continue the same AGY conversation, create a new logical job whose request includes the prior result's `conversationId`.

A continuation is a new user turn, therefore a new job ID is expected. It must not be confused with retrying the same logical job.

## Bounded Parallel Job Concurrency

The bridge supports bounded top-level parallel job execution:

- **Configurable concurrency:** `ANTIGRAVITY_BRIDGE_CONCURRENCY` (default `3`, bounded between 1 and 10) in `bridge/relay.js`.
- **Worker pool:** A single relay process manages an in-process pool of worker slots claiming jobs with PostgreSQL `FOR UPDATE SKIP LOCKED`.
- **Multiplexed SSE:** The relay uses a single multiplexed SSE hub correlating events by `requestId` (job ID) and `conversationId`, preventing cross-talk between concurrent jobs.
- **Server isolation:** Bridge jobs specify `client: "chatgpt-bridge"` and `requestId`, isolating them from the Android GUI `currentSession`.
- **Top-level parallel jobs vs internal subagents:**
  - *Top-level parallel jobs:* Distinct independent tasks enqueued by ChatGPT into `agent_jobs`. Each has its own job ID, claim token, heartbeat, and result row.
  - *Internal AGY subagents:* A single parent AGY job internally spawning subagents via `invoke_subagent`. The parent job waits for its subagents and yields a single consolidated response.
- **Safety boundaries for ChatGPT delegation:**
  - *Safe parallel jobs:* Read-only tasks, independent repositories, or disjoint directory work.
  - *Sequential requirement:* If multiple tasks write to the same repo, files, or git branch, ChatGPT must sequence them (or continue in the same conversation) to prevent race conditions or merge conflicts.
- **Relay lifecycle rule:** A bridge worker must not synchronously restart its own relay while holding an active job. Doing so terminates the active worker and drops the lease; self-restart must be orchestrated out-of-band or after terminal result persistence.

## Security boundary

Termux uses:
- the Supabase publishable key,
- a device-local `ANTIGRAVITY_BRIDGE_CLIENT_SECRET`,
- the `private.bridge_check_request()` pre-request gate.

The raw device secret must remain on Termux. Supabase stores only its SHA-256 hash.

The public completion RPC remains `SECURITY INVOKER`. The narrowly scoped result upsert runs through a helper kept in the non-exposed `private` schema.

Do not expose the service-role or secret key to Termux, Android, prompts, logs, or source control.

## Database validation discipline

For bridge schema or migration updates:
- CI syntax checks on JavaScript/shell scripts do not validate PostgreSQL runtime syntax or behavior.
- Validate SQL migrations against a real PostgreSQL/Supabase database (invoking newly added functions/RPCs and testing privilege boundaries) before declaring migrations complete.
- Preserve actual runtime errors when validation fails instead of relying solely on static inspection.


## Cross-chat resume

Long-running AGY work is durable independently of a ChatGPT turn or chat thread.

For long jobs, callers SHOULD include stable descriptive metadata in the stored request:

```json
{
  "resumeKey": "stable-logical-work-key",
  "resumeTitle": "Short human-readable task title"
}
```

These fields are metadata only; relay execution semantics are unchanged.

Before creating a replacement long-running job—especially in a new ChatGPT chat—call:

```sql
select public.find_resumable_agent_job(
  p_requested_by => 'chatgpt',
  p_resume_key => null
);
```

Or pass a known `resumeKey` / `idempotency_key` as `p_resume_key`.

The RPC returns the highest-priority resumable job:
1. A job/result snapshot that still contains active tasks, subagents, or tools.
2. Otherwise the newest `pending`, `claimed`, or `running` job.

The response includes `job_id`, `conversation_id`, `resume_key`, `resume_title`,
`status`, `snapshot_active`, `tasks`, `subagents`, and the latest response snapshot.

If `found=true`, ChatGPT must resume observation of that same logical work instead of
starting it again. A `completed` job with `snapshot_active=true` represents a historical
premature-terminal snapshot and must still be treated as resumable/in-flight evidence.

### Database terminal guard

`public.complete_agent_job(...)` independently checks the supplied task/subagent/bot-tool
snapshot. If any entry is still active, it persists the latest progress but leaves the job
`running` and returns `false`; relay recovery then continues the same AGY conversation.
This database guard protects against a relay-side or ChatGPT-side early-final decision.

This means ending a ChatGPT turn, switching devices, or opening a new chat must not require
replaying the underlying task.
