#!/data/data/com.termux/files/usr/bin/node
"use strict";

const http = require("http");
const os = require("os");

const cfg = {
  supabaseUrl: (process.env.ANTIGRAVITY_BRIDGE_SUPABASE_URL || "").replace(/\/$/, ""),
  supabaseKey: process.env.ANTIGRAVITY_BRIDGE_PUBLISHABLE_KEY || "",
  bridgeSecret: process.env.ANTIGRAVITY_BRIDGE_CLIENT_SECRET || "",
  agyUrl: (process.env.ANTIGRAVITY_BASE_URL || "http://127.0.0.1:8080").replace(/\/$/, ""),
  workerId: process.env.ANTIGRAVITY_BRIDGE_WORKER_ID || `termux-${os.hostname() || "android"}`,
  concurrency: envInt("ANTIGRAVITY_BRIDGE_CONCURRENCY", 3, 1, 10),
  pollMs: envInt("ANTIGRAVITY_BRIDGE_POLL_MS", 3000, 500, 60000),
  heartbeatMs: envInt("ANTIGRAVITY_BRIDGE_HEARTBEAT_MS", 45000, 5000, 120000),
  leaseSeconds: envInt("ANTIGRAVITY_BRIDGE_LEASE_SECONDS", 180, 30, 900),
  jobTimeoutMs: envInt("ANTIGRAVITY_BRIDGE_JOB_TIMEOUT_MS", 3900000, 60000, 21600000)
};

if (!cfg.supabaseUrl || !cfg.supabaseKey || !cfg.bridgeSecret) {
  console.error("Missing ANTIGRAVITY_BRIDGE_SUPABASE_URL / ANTIGRAVITY_BRIDGE_PUBLISHABLE_KEY / ANTIGRAVITY_BRIDGE_CLIENT_SECRET");
  process.exit(2);
}

let stopping = false;
let sseHub = null;
const activeJobIds = new Set();
const activeJobPromises = new Set();

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    stopping = true;
    log("INFO", "shutdown signal received, stopping intake and draining active jobs");
    sseHub?.close();
  });
}
process.on("unhandledRejection", e => log("ERROR", "unhandled rejection", errJson(e)));

function envInt(name, fallback, min, max) {
  const n = Number.parseInt(process.env[name] || "", 10);
  return Math.max(min, Math.min(max, Number.isFinite(n) ? n : fallback));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(level, msg, meta) { console.log(`[${new Date().toISOString()}] [${level}] ${msg}${meta ? ` ${JSON.stringify(meta)}` : ""}`); }
function errJson(e) { return { message: e?.message || String(e), code: e?.code || null, status: e?.status || null }; }

async function jsonFetch(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let body = null;
    if (text) { try { body = JSON.parse(text); } catch { body = text; } }
    if (!res.ok) {
      const e = new Error(`HTTP ${res.status} ${options.method || "GET"} ${new URL(url).pathname}`);
      e.status = res.status; e.body = body; throw e;
    }
    return body;
  } finally { clearTimeout(timer); }
}

function sbHeaders(extra = {}) {
  return { apikey: cfg.supabaseKey, Authorization: `Bearer ${cfg.supabaseKey}`, "x-antigravity-bridge-key": cfg.bridgeSecret, "Content-Type": "application/json", ...extra };
}
async function sb(method, path, body = undefined, extra = {}) {
  return jsonFetch(`${cfg.supabaseUrl}${path}`, { method, headers: sbHeaders(extra), body: body === undefined ? undefined : JSON.stringify(body) });
}
async function rpc(name, args) { return sb("POST", `/rest/v1/rpc/${name}`, args, { Prefer: "return=representation" }); }
async function agy(method, path, body = undefined, timeoutMs = 30000) {
  return jsonFetch(`${cfg.agyUrl}${path}`, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, timeoutMs);
}

async function claimJob() {
  let rows;
  try {
    rows = await rpc("claim_agent_job_wait", {
      p_worker_id: cfg.workerId,
      p_lease_seconds: cfg.leaseSeconds,
      p_timeout_seconds: 25,
      p_poll_interval_ms: 1000
    });
  } catch (e) {
    // Backward-compatible fallback while database migration rolls out.
    rows = await rpc("claim_agent_job", {
      p_worker_id: cfg.workerId,
      p_lease_seconds: cfg.leaseSeconds
    });
  }
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}
async function heartbeat(job) {
  return Boolean(await rpc("heartbeat_agent_job", { p_job_id: job.id, p_worker_id: cfg.workerId, p_claim_token: job.claim_token, p_lease_seconds: cfg.leaseSeconds }));
}
async function markRunning(job, conversationId = null) {
  return Boolean(await rpc("mark_agent_job_running", { p_job_id: job.id, p_worker_id: cfg.workerId, p_claim_token: job.claim_token, p_conversation_id: conversationId, p_lease_seconds: cfg.leaseSeconds }));
}
async function bindConversation(job, conversationId) {
  const ok = Boolean(await rpc("bind_agent_job_conversation", { p_job_id: job.id, p_worker_id: cfg.workerId, p_claim_token: job.claim_token, p_conversation_id: conversationId }));
  if (ok) job.conversation_id = conversationId;
  return ok;
}
async function completeJob(job, result) {
  return Boolean(await rpc("complete_agent_job", {
    p_job_id: job.id, p_worker_id: cfg.workerId, p_claim_token: job.claim_token,
    p_conversation_id: result.conversationId || job.conversation_id || "",
    p_response_text: result.responseText || "", p_bot_message: result.botMessage || null,
    p_subagents: result.subagents || [], p_tasks: result.tasks || []
  }));
}
async function failJob(job, error) {
  return Boolean(await rpc("fail_agent_job", { p_job_id: job.id, p_worker_id: cfg.workerId, p_claim_token: job.claim_token, p_error: error }));
}
const heartbeatCoupledEvents = new Set([
  "relay_claimed","submitted","generating_start","init","tool_update",
  "subagents_update","tasks_update","account_switched","auth_required",
  "done","error","stopped","generating_done","recovery_started"
]);

async function event(job, eventType, payload = {}) {
  const jobId = job?.id;
  if (!jobId) return;
  try {
    if (heartbeatCoupledEvents.has(eventType) && job.worker_id && job.claim_token) {
      const eventId = await rpc("record_agent_event", {
        p_job_id: job.id,
        p_worker_id: cfg.workerId,
        p_claim_token: job.claim_token,
        p_event_type: eventType,
        p_payload: payload,
        p_lease_seconds: cfg.leaseSeconds
      });
      if (eventId != null) return eventId;
    }
    await sb("POST", "/rest/v1/agent_events", { job_id: jobId, event_type: eventType, payload }, { Prefer: "return=minimal" });
  } catch (e) {
    log("WARN", "event write failed", { jobId, eventType, ...errJson(e) });
  }
}

class SseHub {
  constructor(url) {
    this.url = new URL(url);
    this.subscribers = new Set();
    this.req = null;
    this.closed = false;
    this.reconnectTimer = null;
    this.buffer = "";
  }
  start() {
    if (this.closed) return;
    const req = http.request(this.url, { headers: { Accept: "text/event-stream" } }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        this.scheduleReconnect();
        return;
      }
      res.setEncoding("utf8");
      res.on("data", chunk => this.onData(chunk));
      res.on("end", () => this.scheduleReconnect());
      res.on("error", () => this.scheduleReconnect());
    });
    this.req = req;
    req.on("error", () => this.scheduleReconnect());
    req.end();
  }
  scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    this.req = null;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start();
    }, 2000);
  }
  onData(chunk) {
    this.buffer += String(chunk).replace(/\r\n/g, "\n");
    for (;;) {
      const i = this.buffer.indexOf("\n\n");
      if (i < 0) break;
      const block = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 2);
      const parsed = parseSse(block);
      if (parsed) {
        for (const sub of this.subscribers) {
          try { sub(parsed); } catch (e) { log("WARN", "sse listener error", errJson(e)); }
        }
      }
    }
  }
  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }
  close() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.req?.destroy();
    this.subscribers.clear();
  }
}

function parseSse(block) {
  if (!block || block.startsWith(":")) return null;
  let name = "message"; const data = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) name = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return { name, data: null };
  const raw = data.join("\n");
  try { return { name, data: JSON.parse(raw) }; } catch { return { name, data: { raw } }; }
}

function startHeartbeat(job, onOwnershipLost = null) {
  let busy = false;
  let active = true;
  const t = setInterval(async () => {
    if (!active || busy || stopping) return;
    busy = true;
    try {
      const ok = await heartbeat(job);
      if (!ok) {
        log("WARN", "heartbeat ownership lost or terminal state reached", { jobId: job.id });
        active = false;
        clearInterval(t);
        if (typeof onOwnershipLost === "function") {
          onOwnershipLost();
        }
      }
    } catch (e) {
      log("WARN", "heartbeat failed", { jobId: job.id, ...errJson(e) });
    } finally {
      busy = false;
    }
  }, cfg.heartbeatMs);
  return () => {
    active = false;
    clearInterval(t);
  };
}

function buildChatBody(job) {
  const r = job.request || {};
  const conversationId = String(job.conversation_id || r.conversationId || "").trim();
  const out = { prompt: String(r.prompt || "").trim(), continue: Boolean(conversationId), requestId: job.id, client: "chatgpt-bridge", useVault: r.useVault !== false, autoCompact: r.autoCompact !== false };
  if (conversationId) out.conversationId = conversationId;
  for (const k of ["model", "effort", "mode"]) if (typeof r[k] === "string" && r[k].trim()) out[k] = r[k].trim();
  if (Number.isInteger(r.compactThresholdTokens)) out.compactThresholdTokens = r.compactThresholdTokens;
  if (Array.isArray(r.attachments)) out.attachments = r.attachments;
  return out;
}

function belongs(ev, job, conversationId) {
  const d = ev?.data;
  if (!d || typeof d !== "object") return false;
  if (d.requestId) return d.requestId === job.id;
  return Boolean(conversationId && d.conversationId === conversationId);
}

const persistedEvents = new Set(["generating_start", "init", "tool_update", "subagents_update", "tasks_update", "account_switched", "auth_required", "done", "error", "stopped", "generating_done"]);

async function collectResult(job, conversationId, doneBot = null) {
  let session = null, subagents = [], tasks = [];
  if (conversationId) {
    try { session = (await agy("GET", `/api/conversations/${encodeURIComponent(conversationId)}`, undefined, 15000))?.session || null; } catch {}
    try { subagents = (await agy("GET", `/api/conversations/${encodeURIComponent(conversationId)}/subagents`, undefined, 10000))?.subagents || []; } catch {}
    try { tasks = (await agy("GET", `/api/conversations/${encodeURIComponent(conversationId)}/tasks`, undefined, 10000))?.tasks || []; } catch {}
  }
  let bot = doneBot;
  if ((!bot || !String(bot.content || "").trim()) && Array.isArray(session?.messages)) bot = [...session.messages].reverse().find(m => m?.role === "bot") || bot;
  return { conversationId: conversationId || session?.conversationId || job.conversation_id || null, responseText: typeof bot?.content === "string" ? bot.content : "", botMessage: bot || null, subagents: Array.isArray(subagents) ? subagents : [], tasks: Array.isArray(tasks) ? tasks : [] };
}

async function runJob(job) {
  activeJobIds.add(job.id);
  let ownershipLost = false;
  let waiter = null;
  const stopHeartbeat = startHeartbeat(job, () => {
    ownershipLost = true;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w({ name: "_ownership_lost" });
    }
  });

  let conversationId = job.conversation_id || null;
  let doneBot = null;
  let streamedText = "";
  const deadline = Date.now() + cfg.jobTimeoutMs;

  const eventQueue = [];

  const unsubscribe = sseHub.subscribe((ev) => {
    if (belongs(ev, job, conversationId)) {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(ev);
      } else {
        eventQueue.push(ev);
      }
    }
  });

  function nextEvent(timeoutMs = 10000) {
    if (eventQueue.length > 0) return Promise.resolve(eventQueue.shift());
    if (stopping) return Promise.reject(new Error("Relay stopping"));
    if (ownershipLost) {
      const e = new Error("Job ownership lost or cancelled");
      e.code = "JOB_OWNERSHIP_LOST";
      return Promise.reject(e);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (waiter === onEv) waiter = null;
        const e = new Error("SSE event timeout");
        e.code = "SSE_TIMEOUT";
        reject(e);
      }, timeoutMs);
      const onEv = (ev) => {
        clearTimeout(timer);
        resolve(ev);
      };
      waiter = onEv;
    });
  }

  try {
    await event(job, "relay_claimed", { workerId: cfg.workerId, attempt: job.attempts });
    if (!(await markRunning(job, conversationId))) throw new Error("lost job ownership before run");
    const body = buildChatBody(job);
    await event(job, "submitted", { requestId: job.id, conversationId: body.conversationId || null, model: body.model || null, effort: body.effort || null, mode: body.mode || null });
    await agy("POST", "/api/chat", body, 30000);

    while (!stopping && Date.now() < deadline) {
      if (ownershipLost) {
        const e = new Error("Job ownership lost or cancelled");
        e.code = "JOB_OWNERSHIP_LOST";
        throw e;
      }

      let ev;
      try {
        ev = await nextEvent(10000);
      } catch (e) {
        if (e.code === "SSE_TIMEOUT") {
          // A quiet SSE interval is not a terminal signal. AGY can transiently report
          // isGenerating=false while a generation is starting or transitioning.
          // Treat that state only as an opportunity to recover a durable final result;
          // never fail a live job solely because one conversation snapshot is inactive.
          if (conversationId) {
            try {
              const statusCheck = await agy("GET", `/api/conversations/${encodeURIComponent(conversationId)}`, undefined, 5000);
              if (statusCheck && statusCheck.isGenerating === false) {
                const res = await collectResult(job, conversationId, doneBot);
                if (String(res.responseText || "").trim() && sessionMatches(statusCheck.session, job)) {
                  doneBot = res.botMessage;
                  break;
                }
              }
            } catch (err) {
              log("WARN", "watchdog snapshot check failed", { jobId: job.id, ...errJson(err) });
            }
          }
          continue;
        }
        throw e;
      }

      if (ev.name === "_ownership_lost") {
        const e = new Error("Job ownership lost or cancelled");
        e.code = "JOB_OWNERSHIP_LOST";
        throw e;
      }

      if (!belongs(ev, job, conversationId)) continue;
      const d = ev.data || {};
      if (ev.name === "init" && d.conversationId) {
        conversationId = d.conversationId;
        await bindConversation(job, conversationId);
      }
      if (ev.name === "chunk") {
        if (typeof d.full_content === "string" && d.full_content.length >= streamedText.length) streamedText = d.full_content;
        else if (typeof d.text_delta === "string") streamedText += d.text_delta;
      }
      if (persistedEvents.has(ev.name)) await event(job, ev.name, d);
      if (ev.name === "done") {
        conversationId = d.conversationId || conversationId;
        doneBot = d.botMessage || null;
        if (streamedText.trim()) {
          if (!doneBot || typeof doneBot !== "object") doneBot = { role: "bot", state: "done", tools: [] };
          if (!String(doneBot.content || "").trim()) doneBot.content = streamedText;
        }
        break;
      }
      if (ev.name === "generating_done") {
        conversationId = d.conversationId || conversationId;
        if (conversationId) {
          const res = await collectResult(job, conversationId, doneBot);
          if (String(res.responseText || "").trim()) {
            doneBot = res.botMessage;
            break;
          } else {
            const e = new Error("AGY finished generation without a recoverable final response");
            e.code = "EMPTY_FINAL_RESPONSE";
            throw e;
          }
        }
      }
      if (ev.name === "error" || ev.name === "stopped") {
        const e = new Error(d.error || d.message || ev.name);
        e.code = ev.name === "error" ? "AGY_ERROR" : "AGY_STOPPED";
        throw e;
      }
    }

    if (Date.now() >= deadline) {
      const e = new Error("AGY job timeout");
      e.code = "JOB_TIMEOUT";
      throw e;
    }

    // Stop heartbeat immediately upon completion before/with terminal RPC
    stopHeartbeat();

    const result = await collectResult(job, conversationId, doneBot);
    if (!String(result.responseText || "").trim()) {
      const e = new Error("AGY completed without a recoverable final response");
      e.code = "EMPTY_FINAL_RESPONSE";
      throw e;
    }
    if (!(await completeJob(job, result))) throw new Error("lost job ownership at completion");
    await event(job, "relay_completed", { conversationId: result.conversationId, responseChars: result.responseText.length, subagents: result.subagents.length, tasks: result.tasks.length });
    log("INFO", "job completed", { jobId: job.id, conversationId: result.conversationId });
  } catch (e) {
    stopHeartbeat();
    log("ERROR", "job failed", { jobId: job.id, ...errJson(e) });
    if (e.code === "JOB_OWNERSHIP_LOST") {
      log("INFO", "job ownership lost or cancelled, skipping terminal failure write", { jobId: job.id });
      return;
    }
    if (conversationId && !["AGY_ERROR", "AGY_STOPPED", "JOB_TIMEOUT", "EMPTY_FINAL_RESPONSE", "CHILD_EXITED_WITHOUT_RESULT"].includes(e.code)) {
      try {
        await recoverRunning(job, conversationId, deadline);
        return;
      } catch (re) {
        e = re;
      }
    }
    const payload = { code: e.code || "relay_error", ...errJson(e) };
    try { await failJob(job, payload); } catch {}
    await event(job, "relay_failed", payload);
  } finally {
    unsubscribe();
    stopHeartbeat();
    activeJobIds.delete(job.id);
  }
}

function norm(s) { return String(s || "").replace(/\s+/g, " ").trim(); }
function sessionMatches(session, job) {
  const u = Array.isArray(session?.messages) ? [...session.messages].reverse().find(m => m?.role === "user") : null;
  const a = norm(u?.content), b = norm(job.request?.prompt);
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

async function recoverRunning(job, conversationId, deadline = Date.now() + cfg.jobTimeoutMs) {
  let ownershipLost = false;
  const stopHeartbeat = startHeartbeat(job, () => { ownershipLost = true; });
  try {
    if (!(await heartbeat(job))) {
      log("WARN", "heartbeat ownership lost during recovery", { jobId: job.id });
      return;
    }
    await event(job, "recovery_started", { workerId: cfg.workerId, conversationId });
    while (!stopping && Date.now() < deadline) {
      if (ownershipLost) {
        const e = new Error("Job ownership lost or cancelled during recovery");
        e.code = "JOB_OWNERSHIP_LOST";
        throw e;
      }
      let loaded;
      try { loaded = await agy("GET", `/api/conversations/${encodeURIComponent(conversationId)}`, undefined, 10000); }
      catch (e) { if (e.status === 404) { await sleep(cfg.pollMs); continue; } throw e; }
      if (loaded?.isGenerating) { await sleep(cfg.pollMs); continue; }
      if (!sessionMatches(loaded?.session, job)) {
        const e = new Error("recovered conversation latest turn does not match job; duplicate replay refused");
        e.code = "RECOVERY_TURN_MISMATCH";
        throw e;
      }
      const result = await collectResult(job, conversationId);
      if (!String(result.responseText || "").trim()) {
        const e = new Error("AGY recovered conversation has no final response");
        e.code = "EMPTY_FINAL_RESPONSE";
        throw e;
      }
      stopHeartbeat();
      if (!(await completeJob(job, result))) throw new Error("lost recovered job ownership");
      await event(job, "recovery_completed", { conversationId, responseChars: result.responseText.length, subagents: result.subagents.length, tasks: result.tasks.length });
      log("INFO", "recovered job completed", { jobId: job.id, conversationId });
      return;
    }
    const e = new Error("recovery timeout");
    e.code = "RECOVERY_TIMEOUT";
    throw e;
  } finally {
    stopHeartbeat();
  }
}

async function staleJobs() {
  const q = new URLSearchParams({ select: "*", worker_id: `eq.${cfg.workerId}`, status: "in.(claimed,running)", lease_expires_at: `lt.${new Date().toISOString()}`, order: "updated_at.asc", limit: "10" });
  const rows = await sb("GET", `/rest/v1/agent_jobs?${q}`);
  return Array.isArray(rows) ? rows : [];
}

async function recoverStale() {
  let rows;
  try { rows = await staleJobs(); } catch (e) { log("WARN", "stale scan failed", errJson(e)); return; }
  for (const job of rows) {
    if (stopping) return;
    if (activeJobIds.has(job.id)) continue;
    if (job.status === "claimed" && !job.started_at) {
      try {
        const ok = Boolean(await rpc("requeue_stale_claimed_agent_job", { p_job_id: job.id, p_worker_id: cfg.workerId, p_claim_token: job.claim_token }));
        if (ok) {
          await event(job, "stale_claim_requeued", { workerId: cfg.workerId });
          log("INFO", "stale claim requeued", { jobId: job.id });
        }
      } catch (e) {
        log("WARN", "stale claim requeue failed", { jobId: job.id, ...errJson(e) });
      }
    } else if (job.status === "running") {
      if (!job.conversation_id) {
        const p = { code: "STALE_RUNNING_WITHOUT_CONVERSATION", message: "Job was not replayed because relay lost the conversation id; duplicate execution avoided." };
        try { await failJob(job, p); } catch {}
        await event(job, "recovery_failed", p);
        continue;
      }
      try {
        await recoverRunning(job, job.conversation_id);
      } catch (e) {
        const p = { code: e.code || "recovery_error", ...errJson(e) };
        try { await failJob(job, p); } catch {}
        await event(job, "recovery_failed", p);
      }
    }
  }
}

async function agyAvailableCapacity() {
  try {
    const h = await agy("GET", "/api/health", undefined, 3000);
    if (h?.status !== "ok") return 0;
    const s = await agy("GET", "/api/status", undefined, 3000);
    if (typeof s?.availableCapacity === "number") return s.availableCapacity;
    return s?.busy ? 0 : 1;
  } catch {
    return 0;
  }
}

function adaptiveIdlePollMs(idleRounds, rand = Math.random) {
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

async function main() {
  log("INFO", "Antigravity ChatGPT relay starting", { workerId: cfg.workerId, agyUrl: cfg.agyUrl, concurrency: cfg.concurrency });
  sseHub = new SseHub(`${cfg.agyUrl}/api/events`);
  sseHub.start();

  await recoverStale();
  let lastRecovery = Date.now();
  let idleRounds = 0;

  while (!stopping) {
    try {
      if (Date.now() - lastRecovery > Math.max(30000, cfg.heartbeatMs * 2)) {
        await recoverStale();
        lastRecovery = Date.now();
      }

      if (activeJobPromises.size >= cfg.concurrency) {
        await Promise.race(activeJobPromises);
        continue;
      }

      const capacity = await agyAvailableCapacity();
      if (capacity <= 0 || activeJobPromises.size >= capacity) {
        if (activeJobPromises.size > 0) {
          await Promise.race([...activeJobPromises, sleep(Math.max(cfg.pollMs, 2000))]);
        } else {
          idleRounds += 1;
          await sleep(adaptiveIdlePollMs(idleRounds));
        }
        continue;
      }

      const job = await claimJob();
      if (!job) {
        idleRounds += 1;
        if (activeJobPromises.size > 0) {
          await Promise.race([...activeJobPromises, sleep(250)]);
        } else {
          await sleep(250);
        }
        continue;
      }

      idleRounds = 0;
      log("INFO", "job claimed", { jobId: job.id, attempt: job.attempts, activeJobs: activeJobPromises.size + 1, maxConcurrency: cfg.concurrency });
      const p = runJob(job).finally(() => activeJobPromises.delete(p));
      activeJobPromises.add(p);
    } catch (e) {
      log("ERROR", "relay loop error", errJson(e));
      await sleep(Math.max(cfg.pollMs, 5000));
    }
  }

  if (activeJobPromises.size > 0) {
    log("INFO", "waiting for active jobs on shutdown", { activeJobs: activeJobPromises.size });
    await Promise.allSettled(activeJobPromises);
  }
  log("INFO", "relay stopped", { workerId: cfg.workerId });
}

main().catch(e => { log("ERROR", "fatal relay error", errJson(e)); process.exitCode = 1; });
