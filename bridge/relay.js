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
  pollMs: envInt("ANTIGRAVITY_BRIDGE_POLL_MS", 3000, 500, 60000),
  heartbeatMs: envInt("ANTIGRAVITY_BRIDGE_HEARTBEAT_MS", 20000, 5000, 120000),
  leaseSeconds: envInt("ANTIGRAVITY_BRIDGE_LEASE_SECONDS", 120, 30, 900),
  jobTimeoutMs: envInt("ANTIGRAVITY_BRIDGE_JOB_TIMEOUT_MS", 3900000, 60000, 21600000)
};

if (!cfg.supabaseUrl || !cfg.supabaseKey || !cfg.bridgeSecret) {
  console.error("Missing ANTIGRAVITY_BRIDGE_SUPABASE_URL / ANTIGRAVITY_BRIDGE_PUBLISHABLE_KEY / ANTIGRAVITY_BRIDGE_CLIENT_SECRET");
  process.exit(2);
}

let stopping = false;
let activeSse = null;
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { stopping = true; activeSse?.close(); });
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
  return { apikey: cfg.supabaseKey, "x-antigravity-bridge-key": cfg.bridgeSecret, "Content-Type": "application/json", ...extra };
}
async function sb(method, path, body = undefined, extra = {}) {
  return jsonFetch(`${cfg.supabaseUrl}${path}`, { method, headers: sbHeaders(extra), body: body === undefined ? undefined : JSON.stringify(body) });
}
async function rpc(name, args) { return sb("POST", `/rest/v1/rpc/${name}`, args, { Prefer: "return=representation" }); }
async function agy(method, path, body = undefined, timeoutMs = 30000) {
  return jsonFetch(`${cfg.agyUrl}${path}`, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, timeoutMs);
}

async function claimJob() {
  const rows = await rpc("claim_agent_job", { p_worker_id: cfg.workerId, p_lease_seconds: cfg.leaseSeconds });
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
async function event(jobId, eventType, payload = {}) {
  try { await sb("POST", "/rest/v1/agent_events", { job_id: jobId, event_type: eventType, payload }, { Prefer: "return=minimal" }); }
  catch (e) { log("WARN", "event write failed", { jobId, eventType, ...errJson(e) }); }
}

class SseStream {
  constructor(url) { this.url = new URL(url); this.queue = []; this.waiters = []; this.buffer = ""; this.closed = false; this.req = null; }
  connect() {
    return new Promise((resolve, reject) => {
      const req = http.request(this.url, { headers: { Accept: "text/event-stream" } }, res => {
        if (res.statusCode !== 200) { res.resume(); reject(new Error(`SSE HTTP ${res.statusCode}`)); return; }
        res.setEncoding("utf8");
        res.on("data", chunk => this.onData(chunk));
        res.on("end", () => this.finish(new Error("SSE ended")));
        res.on("error", e => this.finish(e));
        resolve(this);
      });
      this.req = req; req.on("error", reject); req.end();
    });
  }
  onData(chunk) {
    this.buffer += String(chunk).replace(/\r\n/g, "\n");
    for (;;) {
      const i = this.buffer.indexOf("\n\n"); if (i < 0) break;
      const block = this.buffer.slice(0, i); this.buffer = this.buffer.slice(i + 2);
      const parsed = parseSse(block); if (parsed) this.push(parsed);
    }
  }
  push(v) { const w = this.waiters.shift(); if (w) { clearTimeout(w.t); w.resolve(v); } else this.queue.push(v); }
  next(ms = 15000) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.closed) return Promise.reject(new Error("SSE closed"));
    return new Promise((resolve, reject) => {
      const w = { resolve, reject, t: null };
      w.t = setTimeout(() => { this.waiters = this.waiters.filter(x => x !== w); const e = new Error("SSE event timeout"); e.code = "SSE_TIMEOUT"; reject(e); }, ms);
      this.waiters.push(w);
    });
  }
  finish(e) { if (this.closed) return; this.closed = true; for (const w of this.waiters.splice(0)) { clearTimeout(w.t); w.reject(e); } }
  close() { this.closed = true; this.req?.destroy(); for (const w of this.waiters.splice(0)) { clearTimeout(w.t); w.reject(new Error("SSE closed")); } }
}
function parseSse(block) {
  if (!block || block.startsWith(":")) return null;
  let name = "message"; const data = [];
  for (const line of block.split("\n")) { if (line.startsWith("event:")) name = line.slice(6).trim(); else if (line.startsWith("data:")) data.push(line.slice(5).trimStart()); }
  if (!data.length) return { name, data: null };
  const raw = data.join("\n"); try { return { name, data: JSON.parse(raw) }; } catch { return { name, data: { raw } }; }
}

function startHeartbeat(job) {
  let busy = false;
  const t = setInterval(async () => {
    if (busy || stopping) return; busy = true;
    try { if (!(await heartbeat(job))) log("WARN", "heartbeat ownership lost", { jobId: job.id }); }
    catch (e) { log("WARN", "heartbeat failed", { jobId: job.id, ...errJson(e) }); }
    finally { busy = false; }
  }, cfg.heartbeatMs);
  return () => clearInterval(t);
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
  const d = ev?.data; if (!d || typeof d !== "object") return false;
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
  const stopHeartbeat = startHeartbeat(job); let stream = null; let conversationId = job.conversation_id || null; let doneBot = null;
  const deadline = Date.now() + cfg.jobTimeoutMs;
  try {
    await event(job.id, "relay_claimed", { workerId: cfg.workerId, attempt: job.attempts });
    stream = await new SseStream(`${cfg.agyUrl}/api/events`).connect(); activeSse = stream;
    if (!(await markRunning(job, conversationId))) throw new Error("lost job ownership before run");
    const body = buildChatBody(job);
    await event(job.id, "submitted", { requestId: job.id, conversationId: body.conversationId || null, model: body.model || null, effort: body.effort || null, mode: body.mode || null });
    await agy("POST", "/api/chat", body, 30000);

    while (!stopping && Date.now() < deadline) {
      let ev; try { ev = await stream.next(15000); } catch (e) { if (e.code === "SSE_TIMEOUT") continue; throw e; }
      if (!belongs(ev, job, conversationId)) continue;
      const d = ev.data || {};
      if (ev.name === "init" && d.conversationId) { conversationId = d.conversationId; await bindConversation(job, conversationId); }
      if (persistedEvents.has(ev.name)) await event(job.id, ev.name, d);
      if (ev.name === "done") { conversationId = d.conversationId || conversationId; doneBot = d.botMessage || null; break; }
      if (ev.name === "error" || ev.name === "stopped") { const e = new Error(d.error || d.message || ev.name); e.code = ev.name === "error" ? "AGY_ERROR" : "AGY_STOPPED"; throw e; }
    }
    if (Date.now() >= deadline) { const e = new Error("AGY job timeout"); e.code = "JOB_TIMEOUT"; throw e; }
    const result = await collectResult(job, conversationId, doneBot);
    if (!(await completeJob(job, result))) throw new Error("lost job ownership at completion");
    await event(job.id, "relay_completed", { conversationId: result.conversationId, responseChars: result.responseText.length, subagents: result.subagents.length, tasks: result.tasks.length });
    log("INFO", "job completed", { jobId: job.id, conversationId: result.conversationId });
  } catch (e) {
    log("ERROR", "job failed", { jobId: job.id, ...errJson(e) });
    if (conversationId && !["AGY_ERROR", "AGY_STOPPED", "JOB_TIMEOUT"].includes(e.code)) {
      try { await recoverRunning(job, conversationId, deadline); return; } catch (re) { e = re; }
    }
    const payload = { code: e.code || "relay_error", ...errJson(e) };
    try { await failJob(job, payload); } catch {}
    await event(job.id, "relay_failed", payload);
  } finally { stopHeartbeat(); stream?.close(); if (activeSse === stream) activeSse = null; }
}

function norm(s) { return String(s || "").replace(/\s+/g, " ").trim(); }
function sessionMatches(session, job) {
  const u = Array.isArray(session?.messages) ? [...session.messages].reverse().find(m => m?.role === "user") : null;
  const a = norm(u?.content), b = norm(job.request?.prompt); return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}
async function recoverRunning(job, conversationId, deadline = Date.now() + cfg.jobTimeoutMs) {
  const stopHeartbeat = startHeartbeat(job);
  try {
    await heartbeat(job); await event(job.id, "recovery_started", { workerId: cfg.workerId, conversationId });
    while (!stopping && Date.now() < deadline) {
      let loaded; try { loaded = await agy("GET", `/api/conversations/${encodeURIComponent(conversationId)}`, undefined, 10000); }
      catch (e) { if (e.status === 404) { await sleep(cfg.pollMs); continue; } throw e; }
      if (loaded?.isGenerating) { await sleep(cfg.pollMs); continue; }
      if (!sessionMatches(loaded?.session, job)) { const e = new Error("recovered conversation latest turn does not match job; duplicate replay refused"); e.code = "RECOVERY_TURN_MISMATCH"; throw e; }
      const result = await collectResult(job, conversationId);
      if (!(await completeJob(job, result))) throw new Error("lost recovered job ownership");
      await event(job.id, "recovery_completed", { conversationId, responseChars: result.responseText.length, subagents: result.subagents.length, tasks: result.tasks.length });
      log("INFO", "recovered job completed", { jobId: job.id, conversationId }); return;
    }
    const e = new Error("recovery timeout"); e.code = "RECOVERY_TIMEOUT"; throw e;
  } finally { stopHeartbeat(); }
}

async function staleJobs() {
  const q = new URLSearchParams({ select: "*", worker_id: `eq.${cfg.workerId}`, status: "in.(claimed,running)", lease_expires_at: `lt.${new Date().toISOString()}`, order: "updated_at.asc", limit: "10" });
  const rows = await sb("GET", `/rest/v1/agent_jobs?${q}`); return Array.isArray(rows) ? rows : [];
}
async function recoverStale() {
  let rows; try { rows = await staleJobs(); } catch (e) { log("WARN", "stale scan failed", errJson(e)); return; }
  for (const job of rows) {
    if (stopping) return;
    if (job.status === "claimed" && !job.started_at) {
      try {
        const ok = Boolean(await rpc("requeue_stale_claimed_agent_job", { p_job_id: job.id, p_worker_id: cfg.workerId, p_claim_token: job.claim_token }));
        if (ok) { await event(job.id, "stale_claim_requeued", { workerId: cfg.workerId }); log("INFO", "stale claim requeued", { jobId: job.id }); }
      } catch (e) { log("WARN", "stale claim requeue failed", { jobId: job.id, ...errJson(e) }); }
    } else if (job.status === "running") {
      if (!job.conversation_id) {
        const p = { code: "STALE_RUNNING_WITHOUT_CONVERSATION", message: "Job was not replayed because relay lost the conversation id; duplicate execution avoided." };
        try { await failJob(job, p); } catch {} await event(job.id, "recovery_failed", p); continue;
      }
      try { await recoverRunning(job, job.conversation_id); }
      catch (e) { const p = { code: e.code || "recovery_error", ...errJson(e) }; try { await failJob(job, p); } catch {} await event(job.id, "recovery_failed", p); }
    }
  }
}

async function agyAvailableAndIdle() {
  try { const h = await agy("GET", "/api/health", undefined, 3000); if (h?.status !== "ok") return false; const s = await agy("GET", "/api/status", undefined, 3000); return !s?.busy; }
  catch { return false; }
}

async function main() {
  log("INFO", "Antigravity ChatGPT relay starting", { workerId: cfg.workerId, agyUrl: cfg.agyUrl });
  await recoverStale(); let lastRecovery = Date.now();
  while (!stopping) {
    try {
      if (Date.now() - lastRecovery > Math.max(30000, cfg.heartbeatMs * 2)) { await recoverStale(); lastRecovery = Date.now(); }
      if (!(await agyAvailableAndIdle())) { await sleep(Math.max(cfg.pollMs, 5000)); continue; }
      const job = await claimJob(); if (!job) { await sleep(cfg.pollMs); continue; }
      log("INFO", "job claimed", { jobId: job.id, attempt: job.attempts }); await runJob(job);
    } catch (e) { log("ERROR", "relay loop error", errJson(e)); await sleep(Math.max(cfg.pollMs, 5000)); }
  }
  log("INFO", "relay stopped", { workerId: cfg.workerId });
}

main().catch(e => { log("ERROR", "fatal relay error", errJson(e)); process.exitCode = 1; });
