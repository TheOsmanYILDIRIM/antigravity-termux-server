const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn, exec } = require("child_process");

process.on("uncaughtException", (err) => {
  console.error("[CRITICAL - CLINE UNCAUGHT EXCEPTION]", err);
  try {
    fs.appendFileSync("/data/data/com.termux/files/home/cline_diag.log", `[${new Date().toISOString()}] UNCAUGHT ${err.stack || err.message}\n`);
  } catch (e) {}
});

process.on("unhandledRejection", (reason) => {
  console.error("[CRITICAL - CLINE UNHANDLED REJECTION]", reason);
});

const PORT = process.env.PORT || 5115;
const HOST = process.env.HOST || "0.0.0.0";
const CLINE_HOME = process.env.CLINE_TERMUX_HOME || "/data/data/com.termux/files/usr/opt/cline-termux/current";
const BUN_BIN = process.env.CLINE_TERMUX_BUN || "/data/data/com.termux/files/usr/opt/bun-android-ffi/current/bun";
const CLINE_DATA_DIR = path.join(process.env.HOME || "/data/data/com.termux/files/home", ".cline", "data");
const CLINE_SESSIONS_DIR = path.join(CLINE_DATA_DIR, "sessions");
const CLINE_SETTINGS_DIR = path.join(CLINE_DATA_DIR, "settings");
const UPLOADS_DIR = "/data/data/com.termux/files/home/uploads";
const VAULT_DIR = "/data/data/com.termux/files/home/agy-vault";
const AGENTS_SKILLS_DIR = "/data/data/com.termux/files/home/.agents/skills";

if (!fs.existsSync(CLINE_SESSIONS_DIR)) fs.mkdirSync(CLINE_SESSIONS_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(VAULT_DIR)) fs.mkdirSync(VAULT_DIR, { recursive: true });

// Multi-chat process registry: Map<conversationId, { child, botMessage, convId, startedAt }>
const activeProcesses = new Map();
let sseClients = [];

// SSE Keep-Alive Ping Interval (Every 15s)
setInterval(() => {
  if (sseClients.length === 0) return;
  const dead = [];
  sseClients.forEach(client => {
    try {
      client.res.write(": ping\n\n");
    } catch (e) {
      dead.push(client.id);
    }
  });
  if (dead.length > 0) {
    sseClients = sseClients.filter(c => !dead.includes(c.id));
  }
}, 15000);

function broadcastSSE(event, data) {
  const payload = "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n";
  let sent = 0;
  sseClients.forEach(client => {
    try { client.res.write(payload); sent++; } catch (e) {}
  });
  try {
    const diagLine = `[${new Date().toISOString()}] CLINE SSE event="${event}" convId=${data && data.conversationId} clients=${sent}/${sseClients.length}`;
    fs.appendFileSync("/data/data/com.termux/files/home/cline_sse.log", diagLine + "\n");
  } catch (e) {}
}

// Generate unique session ID matching Cline convention
function generateClineSessionId() {
  const ts = Date.now();
  const rand = Math.random().toString(36).substring(2, 7);
  return `${ts}_${rand}`;
}

// Load session metadata and messages from Cline data store
function loadClineSession(sessionId) {
  const sessionDir = path.join(CLINE_SESSIONS_DIR, sessionId);
  if (!fs.existsSync(sessionDir)) return null;

  let meta = {};
  let messages = [];

  const metaPath = path.join(sessionDir, `${sessionId}.json`);
  if (fs.existsSync(metaPath)) {
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    } catch (e) {}
  }

  const msgsPath = path.join(sessionDir, `${sessionId}.messages.json`);
  if (fs.existsSync(msgsPath)) {
    try {
      const rawMsgs = JSON.parse(fs.readFileSync(msgsPath, "utf-8"));
      if (rawMsgs && Array.isArray(rawMsgs.messages)) {
        messages = rawMsgs.messages.map((m, idx) => {
          let role = m.role === "assistant" ? "bot" : (m.role === "user" ? "user" : "bot");
          let text = "";
          let tools = [];

          if (typeof m.content === "string") {
            text = m.content;
          } else if (Array.isArray(m.content)) {
            m.content.forEach((part, pIdx) => {
              if (part.type === "text" && part.text) {
                text += (text ? "\n" : "") + part.text;
              } else if (part.type === "tool_use") {
                tools.push({
                  step_index: idx * 10 + pIdx,
                  name: part.name || "tool",
                  state: "DONE",
                  parameters: part.input || {},
                  output: null,
                  duration_seconds: null,
                  error: null
                });
              }
            });
          }

          // Clean <user_input mode="..."> tags from UI display
          if (role === "user") {
            text = text.replace(/^<user_input[^>]*>/, "").replace(/<\/user_input>$/, "").trim();
          }

          return {
            id: m.id || `msg_${idx}`,
            role: role,
            content: text,
            tools: tools,
            time: m.ts ? new Date(m.ts).toISOString() : new Date().toISOString(),
            state: "done"
          };
        });
      }
    } catch (e) {}
  }

  let title = (meta.metadata && meta.metadata.title) || meta.prompt || "";
  title = title.replace(/^<user_input[^>]*>/, "").replace(/<\/user_input>$/, "").trim();
  if (title.length > 50) title = title.substring(0, 50) + "…";
  if (!title) title = `Cline Sohbet (${sessionId.substring(sessionId.length - 5)})`;

  return {
    id: sessionId,
    conversationId: sessionId,
    title: title,
    messages: messages,
    isGenerating: activeProcesses.has(sessionId)
  };
}

// List all Cline conversations
function listClineConversations() {
  if (!fs.existsSync(CLINE_SESSIONS_DIR)) return [];
  const entries = fs.readdirSync(CLINE_SESSIONS_DIR, { withFileTypes: true });
  const sessions = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const sessionId = entry.name;
      const sessionDir = path.join(CLINE_SESSIONS_DIR, sessionId);
      const metaPath = path.join(sessionDir, `${sessionId}.json`);
      const msgsPath = path.join(sessionDir, `${sessionId}.messages.json`);

      let title = "";
      let updatedAt = 0;
      let messageCount = 0;

      if (fs.existsSync(metaPath)) {
        try {
          const stats = fs.statSync(metaPath);
          updatedAt = stats.mtimeMs;
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
          title = (meta.metadata && meta.metadata.title) || meta.prompt || "";
          title = title.replace(/^<user_input[^>]*>/, "").replace(/<\/user_input>$/, "").trim();
        } catch (e) {}
      }

      if (fs.existsSync(msgsPath)) {
        try {
          const stats = fs.statSync(msgsPath);
          if (stats.mtimeMs > updatedAt) updatedAt = stats.mtimeMs;
          const raw = JSON.parse(fs.readFileSync(msgsPath, "utf-8"));
          if (raw && Array.isArray(raw.messages)) messageCount = raw.messages.length;
        } catch (e) {}
      }

      if (title.length > 40) title = title.substring(0, 40) + "…";
      if (!title) title = `Sohbet ${sessionId.substring(0, 8)}`;

      sessions.push({
        id: sessionId,
        title: title,
        messageCount: messageCount,
        updatedAt: updatedAt || Date.now()
      });
    }
  }

  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return sessions;
}

// Get available models from Cline providers
function getClineModels() {
  const defaultModels = [
    { id: "stealth/union-alpha", name: "Cline Union Alpha (Stealth)", description: "Akıllı & Hızlı Kodlama Modeli" },
    { id: "anthropic/claude-3-7-sonnet", name: "Claude 3.7 Sonnet (Thinking)", description: "Gelişmiş analitik akıl yürütme" },
    { id: "anthropic/claude-3-5-sonnet", name: "Claude 3.5 Sonnet", description: "Standart güçlü kodlama modeli" },
    { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", description: "Hafif ve seri model" },
    { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro", description: "Derin mimari model" },
    { id: "deepseek/deepseek-chat", name: "DeepSeek V3", description: "Düşük maliyetli güçlü model" },
    { id: "deepseek/deepseek-reasoner", name: "DeepSeek R1", description: "Akıl yürütme modeli" }
  ];

  const providersPath = path.join(CLINE_SETTINGS_DIR, "providers.json");
  if (fs.existsSync(providersPath)) {
    try {
      const provs = JSON.parse(fs.readFileSync(providersPath, "utf-8"));
      // Can augment models if custom providers found
    } catch (e) {}
  }
  return defaultModels;
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  // CORS Headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  const pathname = parsedUrl.pathname;

  // Health
  if (pathname === "/health" || pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      server: "cline-termux-bridge",
      version: "3.0.61-termux.2",
      uptime: Math.round(process.uptime()),
      pid: process.pid,
      activeTasks: activeProcesses.size
    }));
    return;
  }

  // SSE Stream: /api/events or /events
  if (pathname === "/api/events" || pathname === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });
    const clientId = Date.now() + "_" + Math.random().toString(36).substring(2, 7);
    const client = { id: clientId, res };
    sseClients.push(client);

    req.on("close", () => {
      sseClients = sseClients.filter(c => c.id !== clientId);
    });
    return;
  }

  // GET /api/conversations
  if (pathname === "/api/conversations" && req.method === "GET") {
    const list = listClineConversations();
    const activeId = activeProcesses.keys().next().value || (list.length > 0 ? list[0].id : null);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      currentConversationId: activeId,
      conversations: list
    }));
    return;
  }

  // GET /api/conversations/:id
  const convMatch = pathname.match(/^\/api\/conversations\/([^/]+)$/);
  if (convMatch && req.method === "GET") {
    const id = convMatch[1];
    const session = loadClineSession(id);
    if (!session) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "error", error: "Oturum bulunamadı." }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      session: session,
      isGenerating: activeProcesses.has(id)
    }));
    return;
  }

  // DELETE /api/conversations/:id
  if (convMatch && req.method === "DELETE") {
    const id = convMatch[1];
    const sessionDir = path.join(CLINE_SESSIONS_DIR, id);
    if (activeProcesses.has(id)) {
      const proc = activeProcesses.get(id);
      try { proc.child.kill("SIGKILL"); } catch (e) {}
      activeProcesses.delete(id);
    }
    if (fs.existsSync(sessionDir)) {
      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      } catch (e) {}
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  // GET /api/models
  if (pathname === "/api/models" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      models: getClineModels()
    }));
    return;
  }

  // GET /api/usage
  if (pathname === "/api/usage" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      usage: {
        total_tokens: 0,
        input_tokens: 0,
        output_tokens: 0
      }
    }));
    return;
  }

  // GET /api/skills
  if (pathname === "/api/skills" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      count: 0,
      skills: []
    }));
    return;
  }

  // POST /api/stop
  if (pathname === "/api/stop" && req.method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      let data = {};
      try { data = JSON.parse(body || "{}"); } catch (e) {}
      const targetConvId = data.conversationId;

      if (targetConvId && activeProcesses.has(targetConvId)) {
        const p = activeProcesses.get(targetConvId);
        try {
          if (p.child && p.child.pid) {
            exec(`pkill -9 -P ${p.child.pid} 2>/dev/null; kill -9 ${p.child.pid} 2>/dev/null || true`);
            p.child.kill("SIGKILL");
          }
        } catch (e) {}
        activeProcesses.delete(targetConvId);
        broadcastSSE("generating_done", { conversationId: targetConvId, isGenerating: false });
        broadcastSSE("stopped", { message: "İşlem durduruldu.", conversationId: targetConvId });
      } else {
        // Stop all active processes
        for (const [cId, p] of activeProcesses.entries()) {
          try {
            if (p.child && p.child.pid) {
              exec(`pkill -9 -P ${p.child.pid} 2>/dev/null; kill -9 ${p.child.pid} 2>/dev/null || true`);
              p.child.kill("SIGKILL");
            }
          } catch (e) {}
          broadcastSSE("generating_done", { conversationId: cId, isGenerating: false });
          broadcastSSE("stopped", { message: "İşlem durduruldu.", conversationId: cId });
        }
        activeProcesses.clear();
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", message: "İşlem durduruldu." }));
    });
    return;
  }

  // POST /api/session/reset
  if (pathname === "/api/session/reset" && req.method === "POST") {
    const newId = generateClineSessionId();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      session: { id: newId, conversationId: newId, title: "Yeni Sohbet", messages: [] }
    }));
    return;
  }

  // POST /api/chat
  if (pathname === "/api/chat" && req.method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        const prompt = payload.prompt || "";
        const continueChat = payload.continueChat !== false;
        let convId = payload.conversationId;

        if (!continueChat || !convId) {
          convId = generateClineSessionId();
        }

        const model = payload.model || (payload.settings && payload.settings.model);
        const effort = payload.effort || (payload.settings && payload.settings.effort);
        const mode = payload.mode || (payload.settings && payload.settings.mode) || "act";

        const botMessage = {
          role: "bot",
          content: "",
          tools: [],
          usage: null,
          time: new Date().toISOString(),
          state: "generating"
        };

        // Notify SSE clients that generation has started for convId
        broadcastSSE("generating_start", {
          conversationId: convId,
          isGenerating: true
        });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "accepted", conversationId: convId, prompt }));

        // Spawn Cline process
        const args = [
          path.join(CLINE_HOME, "index.js"),
          "--id", convId,
          "--yolo",
          "--json"
        ];

        if (model && model !== "default") {
          args.push("-m", model);
        }

        if (effort && ["low", "medium", "high"].includes(effort.toLowerCase())) {
          args.push("--thinking", effort.toLowerCase());
        }

        if (mode && ["plan", "act"].includes(mode.toLowerCase())) {
          args.push(`--${mode.toLowerCase()}`);
        }

        args.push("-p", prompt);

        const env = {
          ...process.env,
          HOME: "/data/data/com.termux/files/home",
          PREFIX: "/data/data/com.termux/files/usr",
          TMPDIR: "/data/data/com.termux/files/usr/tmp",
          CLINE_TERMUX_HOME: CLINE_HOME,
          CLINE_TERMUX_BUN: BUN_BIN,
          CLINE_NO_AUTO_UPDATE: "1",
          SSL_CERT_FILE: "/data/data/com.termux/files/usr/etc/tls/cert.pem",
          SSL_CERT_DIR: path.join(CLINE_HOME, "empty-ca-dir"),
          PATH: process.env.PATH || "/data/data/com.termux/files/usr/bin:/data/data/com.termux/files/usr/bin/applets",
          TERM: "xterm-256color"
        };

        const child = spawn(BUN_BIN, args, {
          cwd: process.env.HOME || "/data/data/com.termux/files/home",
          env: env
        });

        if (child.pid) {
          exec(`taskset -p -c 0-5 ${child.pid} 2>/dev/null; renice 15 -p ${child.pid} 2>/dev/null`);
        }

        activeProcesses.set(convId, { child, botMessage, convId, startedAt: Date.now() });

        let stdoutBuf = "";
        child.stdout.on("data", (chunk) => {
          const raw = chunk.toString("utf-8");
          stdoutBuf += raw;

          const lines = stdoutBuf.split("\n");
          stdoutBuf = lines.pop();

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            try {
              const eventObj = JSON.parse(trimmed);
              if (eventObj.type === "chunk" || eventObj.delta || eventObj.text) {
                const delta = eventObj.delta || eventObj.text || "";
                botMessage.content += delta;
                broadcastSSE("chunk", {
                  text_delta: delta,
                  full_content: botMessage.content,
                  conversationId: convId
                });
              } else if (eventObj.type === "tool" || eventObj.tool) {
                const toolData = {
                  step_index: botMessage.tools.length + 1,
                  name: eventObj.tool || eventObj.name || "tool",
                  state: eventObj.state || "DONE",
                  parameters: eventObj.parameters || eventObj.input || {},
                  output: eventObj.output || null
                };
                botMessage.tools.push(toolData);
                broadcastSSE("tool_update", {
                  tool: toolData,
                  conversationId: convId
                });
              }
            } catch (e) {
              // Raw non-JSON output fallback
              botMessage.content += (botMessage.content ? "\n" : "") + trimmed;
              broadcastSSE("chunk", {
                text_delta: trimmed + "\n",
                full_content: botMessage.content,
                conversationId: convId
              });
            }
          }
        });

        child.stderr.on("data", (chunk) => {
          const errText = chunk.toString("utf-8");
          broadcastSSE("stderr", {
            text: errText,
            conversationId: convId
          });
        });

        child.on("close", (code) => {
          activeProcesses.delete(convId);
          botMessage.state = "done";

          // If content was empty, reload session from disk
          if (!botMessage.content) {
            const reloaded = loadClineSession(convId);
            if (reloaded && reloaded.messages.length > 0) {
              const lastMsg = reloaded.messages[reloaded.messages.length - 1];
              if (lastMsg && lastMsg.role === "bot") {
                botMessage.content = lastMsg.content;
                botMessage.tools = lastMsg.tools;
              }
            }
          }

          broadcastSSE("generating_done", {
            conversationId: convId,
            isGenerating: false
          });

          broadcastSSE("done", {
            botMessage: botMessage,
            conversationId: convId
          });
        });

        child.on("error", (err) => {
          activeProcesses.delete(convId);
          broadcastSSE("error", {
            error: err.message || "Cline process execution error",
            conversationId: convId
          });
          broadcastSSE("generating_done", {
            conversationId: convId,
            isGenerating: false
          });
        });

      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", error: err.message }));
      }
    });
    return;
  }

  // Fallback 404
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "error", error: "Endpoint bulunamadı." }));
});

server.listen(PORT, HOST, () => {
  console.log(`[CLINE-SERVER] Cline Termux Bridge listening on http://${HOST}:${PORT}`);
  try {
    fs.appendFileSync("/data/data/com.termux/files/home/cline_diag.log", `[${new Date().toISOString()}] Server started on ${HOST}:${PORT}\n`);
  } catch (e) {}
});
