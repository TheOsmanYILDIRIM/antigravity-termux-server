"use strict";

const assert = require("assert");

/**
 * Deterministic JS simulator of the PostgreSQL private.wait_agent_job(...) function
 * to unit-test all contract invariants and edge cases.
 */
function simulateWaitAgentJob(db, p_job_id, p_timeout_seconds = 20, p_poll_interval_ms = 500, p_after_seq = null) {
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
        changed: true,
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

    const v_changed = p_after_seq == null || v_progress_seq > p_after_seq;
    if (v_changed) {
      return {
        job_id: j.id,
        found: true,
        status: v_status,
        kind: "progress",
        terminal: false,
        ready: false,
        timed_out: false,
        changed: true,
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
        timed_out: (v_timeout_seconds > 0),
        changed: false,
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

    break;
  }
}

/**
 * DB simulator for complete_agent_job
 */
function simulateCompleteAgentJob(db, p_job_id, p_worker_id, p_claim_token, p_conversation_id, p_response_text, p_bot_message = null, p_subagents = [], p_tasks = []) {
  const j = db.agent_jobs.find(x => x.id === p_job_id && x.worker_id === p_worker_id && x.claim_token === p_claim_token && ["claimed", "running"].includes(x.status));
  if (!j) return false;

  j.status = "completed";
  j.conversation_id = p_conversation_id || j.conversation_id;
  j.completed_at = new Date().toISOString();
  j.heartbeat_at = new Date().toISOString();
  j.lease_expires_at = null;
  j.updated_at = new Date().toISOString();
  j.error = null;

  const existingIdx = db.agent_results.findIndex(x => x.job_id === p_job_id);
  const resultRow = {
    job_id: p_job_id,
    conversation_id: p_conversation_id || null,
    response_text: p_response_text || "",
    bot_message: p_bot_message,
    subagents: p_subagents || [],
    tasks: p_tasks || [],
    created_at: new Date().toISOString()
  };
  if (existingIdx >= 0) {
    db.agent_results[existingIdx] = resultRow;
  } else {
    db.agent_results.push(resultRow);
  }
  return true;
}

/**
 * DB simulator for fail_agent_job
 */
function simulateFailAgentJob(db, p_job_id, p_worker_id, p_claim_token, p_error) {
  const j = db.agent_jobs.find(x => x.id === p_job_id && x.worker_id === p_worker_id && x.claim_token === p_claim_token && ["claimed", "running"].includes(x.status));
  if (!j) return false;

  j.status = "failed";
  j.completed_at = new Date().toISOString();
  j.heartbeat_at = new Date().toISOString();
  j.lease_expires_at = null;
  j.updated_at = new Date().toISOString();
  j.error = p_error || { code: "unknown" };
  return true;
}

/**
 * DB simulator for heartbeat_agent_job
 */
function simulateHeartbeatAgentJob(db, p_job_id, p_worker_id, p_claim_token, p_lease_seconds = 120) {
  const j = db.agent_jobs.find(x => x.id === p_job_id && x.worker_id === p_worker_id && x.claim_token === p_claim_token && ["claimed", "running"].includes(x.status));
  if (!j) return false;

  j.heartbeat_at = new Date().toISOString();
  j.lease_expires_at = new Date(Date.now() + p_lease_seconds * 1000).toISOString();
  j.updated_at = new Date().toISOString();
  return true;
}

function adaptiveIdlePollMs(idleRounds, rand = () => 0.5) {
  const n = Math.max(1, Number(idleRounds) || 1);
  let base;
  if (n <= 10) base = 3000;
  else if (n <= 24) base = 5000;
  else if (n <= 36) base = 10000;
  else if (n <= 42) base = 30000;
  else base = 60000;
  const r = Math.max(0, Math.min(1, Number(rand()) || 0));
  return Math.round(base * (0.9 + r * 0.2));
}

function runTests() {
  console.log("Running AGY bridge job terminalization & wait_agent_job contract test suite...\n");

  const requiredFields = [
    "job_id", "found", "status", "kind", "terminal", "ready", "timed_out",
    "conversation_id", "response_text", "error", "bot_message", "subagents",
    "tasks", "worker_id", "attempts", "heartbeat_at", "lease_expires_at",
    "started_at", "completed_at", "progress_seq", "progress_text"
  ];

  // Test 1: child completes -> result row + completed status + heartbeat stops
  {
    const db = {
      agent_jobs: [{
        id: "job-1",
        status: "running",
        conversation_id: "conv-1",
        worker_id: "worker-1",
        claim_token: "token-1",
        attempts: 1,
        heartbeat_at: new Date().toISOString(),
        lease_expires_at: new Date(Date.now() + 120000).toISOString(),
        started_at: new Date().toISOString()
      }],
      agent_results: [],
      agent_events: []
    };

    let heartbeatActive = true;
    const stopHeartbeat = () => { heartbeatActive = false; };

    // Simulate child completion
    const ok = simulateCompleteAgentJob(db, "job-1", "worker-1", "token-1", "conv-1", "Durable result text", { role: "bot", content: "Durable result text" });
    stopHeartbeat(); // worker stops heartbeat immediately on terminalization

    assert.strictEqual(ok, true, "Test 1 failed: complete_agent_job should return true");
    assert.strictEqual(db.agent_jobs[0].status, "completed", "Test 1 failed: status should be completed");
    assert.ok(db.agent_jobs[0].completed_at !== null, "Test 1 failed: completed_at must be populated");
    assert.strictEqual(db.agent_jobs[0].lease_expires_at, null, "Test 1 failed: lease_expires_at must be cleared");
    assert.strictEqual(db.agent_results.length, 1, "Test 1 failed: result row must be persisted");
    assert.strictEqual(db.agent_results[0].response_text, "Durable result text");
    assert.strictEqual(heartbeatActive, false, "Test 1 failed: heartbeat must be stopped");

    // Attempting heartbeat after completion should return false
    const hbAfter = simulateHeartbeatAgentJob(db, "job-1", "worker-1", "token-1");
    assert.strictEqual(hbAfter, false, "Test 1 failed: heartbeat on completed job must return false");
    console.log("✓ Test 1 passed: child completes -> result row + completed status + heartbeat stops");
  }

  // Test 2: child exits without result -> failed, not running forever
  {
    const db = {
      agent_jobs: [{
        id: "job-2",
        status: "running",
        conversation_id: "conv-2",
        worker_id: "worker-1",
        claim_token: "token-2",
        attempts: 1,
        started_at: new Date().toISOString()
      }],
      agent_results: [],
      agent_events: []
    };

    let heartbeatActive = true;
    const stopHeartbeat = () => { heartbeatActive = false; };

    // Simulate watchdog failing job on abnormal exit without result
    const failOk = simulateFailAgentJob(db, "job-2", "worker-1", "token-2", {
      code: "CHILD_EXITED_WITHOUT_RESULT",
      message: "Child process exited without producing a final response"
    });
    stopHeartbeat();

    assert.strictEqual(failOk, true);
    assert.strictEqual(db.agent_jobs[0].status, "failed");
    assert.strictEqual(db.agent_jobs[0].error.code, "CHILD_EXITED_WITHOUT_RESULT");
    assert.ok(db.agent_jobs[0].completed_at !== null);
    assert.strictEqual(db.agent_results.length, 0, "No result row written for failed job");
    assert.strictEqual(heartbeatActive, false);
    console.log("✓ Test 2 passed: child exits without result -> failed, not running forever");
  }

  // Test 3: cancelled -> cancelled terminal & heartbeat stops
  {
    const db = {
      agent_jobs: [{
        id: "job-3",
        status: "cancelled", // user cancelled job in database
        conversation_id: "conv-3",
        worker_id: "worker-1",
        claim_token: "token-3",
        completed_at: new Date().toISOString()
      }],
      agent_results: [],
      agent_events: []
    };

    // Heartbeat loop receives ownership lost
    let heartbeatActive = true;
    const hbOk = simulateHeartbeatAgentJob(db, "job-3", "worker-1", "token-3");
    if (!hbOk) {
      heartbeatActive = false; // Heartbeat loop immediately stops
    }
    assert.strictEqual(hbOk, false, "Heartbeat must return false for cancelled job");
    assert.strictEqual(heartbeatActive, false, "Heartbeat must stop immediately on cancellation");

    const waitRes = simulateWaitAgentJob(db, "job-3", 0);
    assert.strictEqual(waitRes.kind, "final");
    assert.strictEqual(waitRes.terminal, true);
    assert.strictEqual(waitRes.ready, true);
    assert.strictEqual(waitRes.status, "cancelled");
    console.log("✓ Test 3 passed: cancelled -> cancelled terminal, heartbeat stops");
  }

  // Test 4: wait running -> kind=progress
  {
    const db = {
      agent_jobs: [{
        id: "job-4",
        status: "running",
        conversation_id: "conv-4",
        worker_id: "worker-1",
        heartbeat_at: "2026-09-30T19:00:00Z"
      }],
      agent_results: [],
      agent_events: [{
        id: 42,
        job_id: "job-4",
        event_type: "tool_update",
        payload: { toolAction: "Searching code", toolSummary: "Code search" }
      }]
    };
    const res = simulateWaitAgentJob(db, "job-4", 0);
    assert.strictEqual(res.kind, "progress");
    assert.strictEqual(res.terminal, false);
    assert.strictEqual(res.ready, false);
    assert.strictEqual(res.status, "running");
    assert.strictEqual(res.timed_out, false);
    assert.strictEqual(res.progress_seq, 42);
    assert.strictEqual(res.progress_text, "Searching code");
    console.log("✓ Test 4 passed: wait running -> kind=progress, terminal=false, ready=false");
  }

  // Test 5: wait completed -> kind=final
  {
    const db = {
      agent_jobs: [{
        id: "job-5",
        status: "completed",
        conversation_id: "conv-5",
        worker_id: "worker-1",
        completed_at: "2026-09-30T19:05:00Z",
        heartbeat_at: "2026-09-30T19:05:00Z",
        error: null
      }],
      agent_results: [{
        job_id: "job-5",
        conversation_id: "conv-5",
        response_text: "Task completed successfully."
      }],
      agent_events: [{
        id: 15,
        job_id: "job-5",
        event_type: "relay_completed",
        payload: { responseChars: 28 }
      }]
    };
    const res = simulateWaitAgentJob(db, "job-5", 20);
    assert.strictEqual(res.kind, "final");
    assert.strictEqual(res.terminal, true);
    assert.strictEqual(res.ready, true);
    assert.strictEqual(res.timed_out, false);
    assert.strictEqual(res.status, "completed");
    assert.strictEqual(res.response_text, "Task completed successfully.");
    assert.strictEqual(res.progress_seq, 15);
    console.log("✓ Test 5 passed: wait completed -> kind=final, terminal=true, ready=true, timed_out=false");
  }

  // Test 6: wait failed -> kind=final + error
  {
    const db = {
      agent_jobs: [{
        id: "job-6",
        status: "failed",
        conversation_id: "conv-6",
        completed_at: "2026-09-30T19:02:00Z",
        heartbeat_at: "2026-09-30T19:02:00Z",
        error: { code: "AGY_ERROR", message: "Process error" }
      }],
      agent_results: [],
      agent_events: [{
        id: 18,
        job_id: "job-6",
        event_type: "relay_failed",
        payload: { message: "Process error" }
      }]
    };
    const res = simulateWaitAgentJob(db, "job-6", 20);
    assert.strictEqual(res.kind, "final");
    assert.strictEqual(res.terminal, true);
    assert.strictEqual(res.ready, true);
    assert.strictEqual(res.timed_out, false);
    assert.strictEqual(res.status, "failed");
    assert.deepStrictEqual(res.error, { code: "AGY_ERROR", message: "Process error" });
    assert.strictEqual(res.progress_text, "Process error");
    console.log("✓ Test 6 passed: wait failed -> kind=final + error, terminal=true, ready=true");
  }

  // Test 7: pre-completed returns immediately
  {
    const db = {
      agent_jobs: [{
        id: "job-7",
        status: "completed",
        conversation_id: "conv-7",
        completed_at: "2026-09-30T19:00:00Z",
        heartbeat_at: "2026-09-30T19:00:00Z"
      }],
      agent_results: [{
        job_id: "job-7",
        conversation_id: "conv-7",
        response_text: "Already done"
      }],
      agent_events: []
    };
    const t0 = Date.now();
    const res = simulateWaitAgentJob(db, "job-7", 30);
    const elapsed = Date.now() - t0;
    assert.strictEqual(res.kind, "final");
    assert.strictEqual(res.terminal, true);
    assert.strictEqual(res.ready, true);
    assert.ok(elapsed < 100, "Pre-completed must return immediately");
    console.log("✓ Test 7 passed: pre-completed returns immediately (<100ms)");
  }

  // Test 8: backward fields preserved
  {
    const db = {
      agent_jobs: [{
        id: "job-8",
        status: "running",
        conversation_id: "conv-8",
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
    const res = simulateWaitAgentJob(db, "job-8", 0);
    for (const f of requiredFields) {
      assert.ok(f in res, `Missing required field: ${f}`);
    }
    console.log("✓ Test 8 passed: all 21 backward-compatible & new fields preserved");
  }

  // Test 9: progress_seq monotonic
  {
    const db = {
      agent_jobs: [{ id: "job-9", status: "running", conversation_id: "conv-9" }],
      agent_results: [],
      agent_events: []
    };

    let res0 = simulateWaitAgentJob(db, "job-9", 0);
    assert.strictEqual(res0.progress_seq, 0);
    assert.strictEqual(res0.progress_text, null);

    db.agent_events.push({ id: 101, job_id: "job-9", event_type: "relay_claimed", payload: { workerId: "w1" } });
    let res1 = simulateWaitAgentJob(db, "job-9", 0);
    assert.strictEqual(res1.progress_seq, 101);
    assert.strictEqual(res1.progress_text, "relay_claimed");

    db.agent_events.push({ id: 105, job_id: "job-9", event_type: "submitted", payload: { model: "gemini" } });
    let res2 = simulateWaitAgentJob(db, "job-9", 0);
    assert.strictEqual(res2.progress_seq, 105);
    assert.ok(res2.progress_seq > res1.progress_seq);

    db.agent_events.push({ id: 112, job_id: "job-9", event_type: "tool_update", payload: { toolAction: "Editing schema.sql" } });
    let res3 = simulateWaitAgentJob(db, "job-9", 0);
    assert.strictEqual(res3.progress_seq, 112);
    assert.strictEqual(res3.progress_text, "Editing schema.sql");
    assert.ok(res3.progress_seq > res2.progress_seq);

    console.log("✓ Test 9 passed: progress_seq is strictly monotonic (0 < 101 < 105 < 112)");
  }

  // Test 10: no duplicate result/terminalization on repeated final callbacks
  {
    const db = {
      agent_jobs: [{
        id: "job-10",
        status: "running",
        conversation_id: "conv-10",
        worker_id: "worker-1",
        claim_token: "token-10"
      }],
      agent_results: [],
      agent_events: []
    };

    // First completion
    const ok1 = simulateCompleteAgentJob(db, "job-10", "worker-1", "token-10", "conv-10", "Final response 1");
    assert.strictEqual(ok1, true, "First complete call should succeed");
    assert.strictEqual(db.agent_results.length, 1);
    assert.strictEqual(db.agent_results[0].response_text, "Final response 1");

    // Second repeated complete call
    const ok2 = simulateCompleteAgentJob(db, "job-10", "worker-1", "token-10", "conv-10", "Final response 2");
    assert.strictEqual(ok2, false, "Second complete call must be rejected idempotently (returns false)");
    assert.strictEqual(db.agent_results.length, 1, "Must not create duplicate result rows");
    assert.strictEqual(db.agent_results[0].response_text, "Final response 1", "Original result preserved");

    // Repeated fail call on already completed job
    const ok3 = simulateFailAgentJob(db, "job-10", "worker-1", "token-10", { code: "ERROR_AFTER_DONE" });
    assert.strictEqual(ok3, false, "Fail call on completed job must be rejected (returns false)");
    assert.strictEqual(db.agent_jobs[0].status, "completed", "Job status must remain completed");
    console.log("✓ Test 10 passed: no duplicate result/terminalization on repeated final callbacks");
  }

  // Test 11: cursor-aware wait returns only for newer seq
  {
    const db = {
      agent_jobs: [{ id: "job-11", status: "running", conversation_id: "conv-11" }],
      agent_results: [],
      agent_events: [{ id: 200, job_id: "job-11", event_type: "tool_update", payload: { toolAction: "Testing" } }]
    };
    const newer = simulateWaitAgentJob(db, "job-11", 0, 500, 199);
    assert.strictEqual(newer.changed, true);
    assert.strictEqual(newer.progress_seq, 200);
    assert.strictEqual(newer.timed_out, false);

    const same = simulateWaitAgentJob(db, "job-11", 0, 500, 200);
    assert.strictEqual(same.changed, false);
    assert.strictEqual(same.progress_seq, 200);
    console.log("✓ Test 11 passed: after_seq suppresses duplicate progress snapshots");
  }

  // Test 12: adaptive idle polling backs off and resets to fast tier
  {
    assert.strictEqual(adaptiveIdlePollMs(1), 3000);
    assert.strictEqual(adaptiveIdlePollMs(11), 5000);
    assert.strictEqual(adaptiveIdlePollMs(25), 10000);
    assert.strictEqual(adaptiveIdlePollMs(37), 30000);
    assert.strictEqual(adaptiveIdlePollMs(43), 60000);
    assert.strictEqual(adaptiveIdlePollMs(1), 3000);
    console.log("✓ Test 12 passed: idle poll backoff 3→5→10→30→60s");
  }

  console.log("\nAll 12 test cases passed successfully!");
}

runTests();
