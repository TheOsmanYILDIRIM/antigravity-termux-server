# Agent Continuity Rules

This repository uses persistent continuity for ChatGPT/AGY work.

## Resume gate

When the user asks to continue, resume, check status, finish an interrupted task, or otherwise refers to unfinished work:

1. Query the connected `antigravity-bridge` Supabase project first with `public.find_resumable_agent_job('chatgpt', null)`.
2. If `found=true`, reuse the returned `job_id` and `conversation_id`.
3. If `snapshot_active=true` or status is `pending|claimed|running`, do not create a replacement job.
4. If `resume_required=true`, resume the same job through the existing resume RPC.
5. Fall back to Avenox/Beyin only when no resumable AGY job exists.
6. Never invent operation names, payload fields, or transport behavior.

A parent job marked `completed` is still unfinished when its snapshot contains active work.

## Avenox contract

For the first meaningful Avenox/Beyin task in a session, read `public.get_avenox_contract_snapshot()` from `avenox-bridge`. Cache the returned contract for the session and refresh only when its hash changes or recovery/debugging requires it. Do not use `avenox_turn_context` for normal turns.

## Repository memory

After meaningful repository work, replace this file's **Session handoff** with a short factual handoff: what changed, verification, open work, next step, and branch/commit when known. Do not append an endless journal or include secrets/raw logs.

## Session handoff

Changed: `bridge/relay.js` now allows conversation recovery after `AGY_ERROR` instead of immediately marking the whole job failed.

Why: AGY can finish tools and persist the final bot response, then lose the upstream model transport while closing/finalizing. Previously `AGY_ERROR` was excluded from `recoverRunning()`, so a successful job was misclassified as failed.

Commit: `55bbc567d36f85fd915ad208aaeb55c50e087c3f` on `feature/chatgpt-agent-bridge`.

Verification: source-level path checked; existing `recoverRunning()` already validates conversation identity, waits for generation to stop, requires a non-empty final response, and requires no active tasks/subagents/tools before completing.

Open work: pull this commit on Termux, restart `agy-bridge`, then reproduce/verify that a post-completion AGY transport error recovers to completed instead of failed.
