"use strict";

const assert = require("assert");

/**
 * Deterministic JS simulator of the PostgreSQL private.wait_agent_job(...) function
 * to unit-test all contract invariants and edge cases.
 */
function simulateWaitAgentJob(db, p_job_id, p_timeout_seconds = 20, p_poll_interval_ms = 500) {
  if (!p_job_id) {
    return {
      error: "job_id_required",
      found: false,
      status: null,
      kind: "progress",
      timed_out: false,
      terminal: false,
      ready: false,
      progress_seq: 0,
      progress_text: null
    };
  }

  const v_timeout_seconds = Math.min(Math.max(p_timeout_seconds ?? 20, 0), 30);
  const v_poll_interval_ms = Math.min(Math.max(p_poll_interval_ms ?? 500, 100), 5000);
  const startTime = Date.now();
  const v_deadline = startTime + v_timeout_seconds * 1000;

  // Loop simulation
  while (true) {
    const j = db.agent_jobs.find(x => x.id === p_job_id);
    if (!j) {
      return {
        job_id: p_job_id,
        found: false,
        status: null,
        kind: "progress",
        timed_out: false,
        terminal: false,
        ready: false,
        progress_seq: 0,
        progress_text: null
      };
    }

    const r = db.agent_results.find(x => x.job_id === p_job_id) || {};
    const events = db.agent_events.filter(x => x.job_id === p_job_id).sort((a, b) => b.id - a.id);
    const v_event = events.length > 0 ? events[0] : null;

    const v_status = j.status;
    const v_terminal = ["completed", "failed", "cancelled"].includes(v_status);
    const v_response_text = r.response_text || "";
    const v_conversation_id = r.conversation_id || j.conversation_id || null;
    const v_error = j.error || null;
    const v_bot_message = r.bot_message || null;
    const v_subagents = r.subagents || [];
    const v_tasks = r.tasks || [];

    let v_progress_seq = 0;
    let v_progress_text = null;
    if (v_event) {
      v_progress_seq = v_event.id;
      const p = v_event.payload || {};
      v_progress_text = p.toolAction || p.toolSummary || p.message || p.status || p.summary || v_event.event_type || null;
    }

    let v_ready = false;
    if (v_status === "completed") {
      v_ready = Boolean(
        v_response_text.trim().length > 0 &&
        v_conversation_id &&
        v_conversation_id.trim().length > 0 &&
        v_error === null
      );
    } else if (v_terminal) {
      v_ready = true;
    } else {
      v_ready = false;
    }

    if (v_terminal) {
      return {
        job_id: j.id,
        found: true,
        status: v_status,
        kind: "final",
        terminal: true,
        ready: v_ready,
        timed_out: false,
        conversation_id: v_conversation_id,
        response_text: v_response_text,
        error: v_error,
        bot_message: v_bot_message,
        subagents: v_subagents,
        tasks: v_tasks,
        worker_id: j.worker_id || null,
        attempts: j.attempts || 0,
        heartbeat_at: j.heartbeat_at || null,
        lease_expires_at: j.lease_expires_at || null,
        started_at: j.started_at || null,
        completed_at: j.completed_at || null,
        progress_seq: v_progress_seq,
        progress_text: v_progress_text
      };
    }

    // Check bounded deadline
    if (Date.now() >= v_deadline || v_timeout_seconds === 0) {
      return {
        job_id: j.id,
        found: true,
        status: v_status,
        kind: "progress",
        terminal: false,
        ready: false,
        timed_out: true,
        conversation_id: v_conversation_id,
        response_text: v_response_text,
        error: v_error,
        bot_message: v_bot_message,
        subagents: v_subagents,
        tasks: v_tasks,
        worker_id: j.worker_id || null,
        attempts: j.attempts || 0,
        heartbeat_at: j.heartbeat_at || null,
        lease_expires_at: j.lease_expires_at || null,
        started_at: j.started_at || null,
        completed_at: j.completed_at || null,
        progress_seq: v_progress_seq,
        progress_text: v_progress_text
      };
    }

    break; // simulated single step for instant unit testing
  }
}

function runTests() {
  console.log("Running wait_agent_job response contract test suite...\n");

  const requiredFields = [
    "job_id", "found", "status", "kind", "terminal", "ready", "timed_out",
    "conversation_id", "response_text", "error", "bot_message", "subagents",
    "tasks", "worker_id", "attempts", "heartbeat_at", "lease_expires_at",
    "started_at", "completed_at", "progress_seq", "progress_text"
  ];

  // Test 1: running -> kind progress
  {
    const db = {
      agent_jobs: [{
        id: "job-1",
        status: "running",
        conversation_id: "conv-1",
        worker_id: "worker-1",
        attempts: 1,
        heartbeat_at: "2026-09-30T19:00:00Z",
        started_at: "2026-09-30T18:59:00Z"
      }],
      agent_results: [],
      agent_events: [{
        id: 42,
        job_id: "job-1",
        event_type: "tool_update",
        payload: { toolAction: "Searching code", toolSummary: "Code search" }
      }]
    };
    const res = simulateWaitAgentJob(db, "job-1", 0);
    assert.strictEqual(res.kind, "progress", "Test 1 failed: kind should be progress");
    assert.strictEqual(res.terminal, false, "Test 1 failed: terminal should be false");
    assert.strictEqual(res.ready, false, "Test 1 failed: ready should be false");
    assert.strictEqual(res.status, "running", "Test 1 failed: status should be running");
    assert.strictEqual(res.progress_seq, 42, "Test 1 failed: progress_seq should match event id");
    assert.strictEqual(res.progress_text, "Searching code", "Test 1 failed: progress_text should match toolAction");
    console.log("✓ Test 1 passed: running -> kind=progress, terminal=false, ready=false");
  }

  // Test 2: timeout while running -> kind progress, terminal false, timed_out true
  {
    const db = {
      agent_jobs: [{
        id: "job-2",
        status: "running",
        conversation_id: "conv-2",
        worker_id: "worker-1",
        heartbeat_at: "2026-09-30T19:00:00Z"
      }],
      agent_results: [],
      agent_events: [{
        id: 10,
        job_id: "job-2",
        event_type: "generating_start",
        payload: {}
      }]
    };
    const res = simulateWaitAgentJob(db, "job-2", 0);
    assert.strictEqual(res.kind, "progress", "Test 2 failed: kind should be progress");
    assert.strictEqual(res.terminal, false, "Test 2 failed: terminal should be false");
    assert.strictEqual(res.ready, false, "Test 2 failed: ready should be false");
    assert.strictEqual(res.timed_out, true, "Test 2 failed: timed_out should be true");
    assert.strictEqual(res.progress_seq, 10, "Test 2 failed: progress_seq should be 10");
    assert.strictEqual(res.progress_text, "generating_start", "Test 2 failed: progress_text fallback to event_type");
    console.log("✓ Test 2 passed: timeout while running -> kind=progress, terminal=false, timed_out=true");
  }

  // Test 3: completed -> kind final, terminal true, ready true, timed_out false
  {
    const db = {
      agent_jobs: [{
        id: "job-3",
        status: "completed",
        conversation_id: "conv-3",
        worker_id: "worker-1",
        completed_at: "2026-09-30T19:05:00Z",
        heartbeat_at: "2026-09-30T19:05:00Z",
        error: null
      }],
      agent_results: [{
        job_id: "job-3",
        conversation_id: "conv-3",
        response_text: "Task completed successfully."
      }],
      agent_events: [{
        id: 15,
        job_id: "job-3",
        event_type: "relay_completed",
        payload: { responseChars: 28 }
      }]
    };
    const res = simulateWaitAgentJob(db, "job-3", 20);
    assert.strictEqual(res.kind, "final", "Test 3 failed: kind should be final");
    assert.strictEqual(res.terminal, true, "Test 3 failed: terminal should be true");
    assert.strictEqual(res.ready, true, "Test 3 failed: ready should be true");
    assert.strictEqual(res.timed_out, false, "Test 3 failed: timed_out should be false");
    assert.strictEqual(res.status, "completed", "Test 3 failed: status should be completed");
    assert.strictEqual(res.response_text, "Task completed successfully.");
    assert.strictEqual(res.progress_seq, 15);
    console.log("✓ Test 3 passed: completed -> kind=final, terminal=true, ready=true, timed_out=false");
  }

  // Test 4: failed -> kind final with error, ready true, timed_out false
  {
    const db = {
      agent_jobs: [{
        id: "job-4",
        status: "failed",
        conversation_id: "conv-4",
        completed_at: "2026-09-30T19:02:00Z",
        heartbeat_at: "2026-09-30T19:02:00Z",
        error: { code: "AGY_ERROR", message: "Build failed on line 12" }
      }],
      agent_results: [],
      agent_events: [{
        id: 18,
        job_id: "job-4",
        event_type: "relay_failed",
        payload: { message: "Build failed on line 12" }
      }]
    };
    const res = simulateWaitAgentJob(db, "job-4", 20);
    assert.strictEqual(res.kind, "final", "Test 4 failed: kind should be final");
    assert.strictEqual(res.terminal, true, "Test 4 failed: terminal should be true");
    assert.strictEqual(res.ready, true, "Test 4 failed: ready should be true for inspectable terminal");
    assert.strictEqual(res.timed_out, false, "Test 4 failed: timed_out should be false");
    assert.strictEqual(res.status, "failed", "Test 4 failed: status should be failed");
    assert.deepStrictEqual(res.error, { code: "AGY_ERROR", message: "Build failed on line 12" });
    assert.strictEqual(res.progress_text, "Build failed on line 12");
    console.log("✓ Test 4 passed: failed -> kind=final with error, terminal=true, ready=true");
  }

  // Test 5: pre-completed returns immediately
  {
    const db = {
      agent_jobs: [{
        id: "job-5",
        status: "completed",
        conversation_id: "conv-5",
        completed_at: "2026-09-30T19:00:00Z",
        heartbeat_at: "2026-09-30T19:00:00Z"
      }],
      agent_results: [{
        job_id: "job-5",
        conversation_id: "conv-5",
        response_text: "Already done"
      }],
      agent_events: []
    };
    const t0 = Date.now();
    const res = simulateWaitAgentJob(db, "job-5", 30);
    const elapsed = Date.now() - t0;
    assert.strictEqual(res.kind, "final", "Test 5 failed: kind should be final");
    assert.strictEqual(res.terminal, true, "Test 5 failed: terminal should be true");
    assert.strictEqual(res.ready, true, "Test 5 failed: ready should be true");
    assert.ok(elapsed < 100, "Test 5 failed: pre-completed should return immediately without waiting");
    console.log("✓ Test 5 passed: pre-completed returns immediately");
  }

  // Test 6: old fields remain intact
  {
    const db = {
      agent_jobs: [{
        id: "job-6",
        status: "running",
        conversation_id: "conv-6",
        worker_id: "w-1",
        attempts: 2,
        heartbeat_at: "2026-09-30T19:01:00Z",
        lease_expires_at: "2026-09-30T19:03:00Z",
        started_at: "2026-09-30T19:00:00Z",
        completed_at: null,
        error: null
      }],
      agent_results: [],
      agent_events: []
    };
    const res = simulateWaitAgentJob(db, "job-6", 0);
    for (const f of requiredFields) {
      assert.ok(f in res, `Test 6 failed: missing field ${f} in response`);
    }
    console.log("✓ Test 6 passed: all existing fields remain present for backward compatibility");
  }

  // Test 7: progress_seq is monotonic across event sequence
  {
    const db = {
      agent_jobs: [{
        id: "job-7",
        status: "running",
        conversation_id: "conv-7"
      }],
      agent_results: [],
      agent_events: []
    };

    // No events -> progress_seq 0
    let res0 = simulateWaitAgentJob(db, "job-7", 0);
    assert.strictEqual(res0.progress_seq, 0);
    assert.strictEqual(res0.progress_text, null);

    // Event 1 added
    db.agent_events.push({ id: 101, job_id: "job-7", event_type: "relay_claimed", payload: { workerId: "w1" } });
    let res1 = simulateWaitAgentJob(db, "job-7", 0);
    assert.strictEqual(res1.progress_seq, 101);
    assert.strictEqual(res1.progress_text, "relay_claimed");

    // Event 2 added
    db.agent_events.push({ id: 105, job_id: "job-7", event_type: "submitted", payload: { model: "gemini" } });
    let res2 = simulateWaitAgentJob(db, "job-7", 0);
    assert.strictEqual(res2.progress_seq, 105);
    assert.ok(res2.progress_seq > res1.progress_seq);

    // Event 3 added
    db.agent_events.push({ id: 112, job_id: "job-7", event_type: "tool_update", payload: { toolAction: "Editing schema.sql" } });
    let res3 = simulateWaitAgentJob(db, "job-7", 0);
    assert.strictEqual(res3.progress_seq, 112);
    assert.strictEqual(res3.progress_text, "Editing schema.sql");
    assert.ok(res3.progress_seq > res2.progress_seq);

    console.log("✓ Test 7 passed: progress_seq is strictly monotonic across events (0 < 101 < 105 < 112)");
  }

  console.log("\nAll 7 test cases passed successfully!");
}

runTests();
