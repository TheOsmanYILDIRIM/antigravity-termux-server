# Agent Continuity Rules

This repository uses persistent continuity for ChatGPT/AGY work.

## Resume gate

When the user asks to continue, resume, check status, finish an interrupted task, or otherwise refers to unfinished work:

1. Query the connected `antigravity-bridge` Supabase project first with:
   `public.find_resumable_agent_job('chatgpt', null)`.
2. If `found=true`, reuse the returned `job_id` and `conversation_id`.
3. If `snapshot_active=true` or the job is `pending`, `claimed`, or `running`, do not create a replacement job.
4. If `resume_required=true`, resume the same job through the existing resume RPC and continue tracking that job.
5. Only fall back to Avenox/Beyin context when no resumable AGY job exists.
6. Never infer operation names, payload fields, or transport behavior that are not present in the live contract.

A parent job marked `completed` does not mean the work is finished when its snapshot still contains active tasks. Treat `snapshot_active=true` as unfinished work.

## Avenox contract

For the first meaningful Avenox/Beyin task in a session, read the live contract snapshot from the connected `avenox-bridge` project via `public.get_avenox_contract_snapshot()`. Cache and follow the returned contract for the session. Do not refresh it again unless the contract hash changes or recovery/debugging is required.

Do not use `avenox_turn_context` for normal turns. Use only capabilities explicitly present in the live contract.

## Repository memory

After a meaningful repository change, update this file's **Session handoff** section before ending the work. Keep it short and factual:

- what changed,
- why,
- current branch/commit when known,
- verification performed,
- unfinished work,
- exact next step.

Do not write chain-of-thought, secrets, tokens, or raw tool logs. Replace the previous handoff instead of endlessly appending history. Long-term detail belongs in normal project docs or git history.

## Session handoff

Current focus: make interrupted ChatGPT/AGY jobs resume reliably instead of being restarted or silently ignored.

Known issue: `find_resumable_agent_job` can return a parent job whose database status is `completed` while its captured task snapshot still contains a running task. In that case the job is resumable and must be treated as unfinished.

Next step: reduce model-side interpretation by exposing a single normalized resume decision from the existing resume lookup path, while preserving current callers.
