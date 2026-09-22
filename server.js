const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn, exec, execSync } = require("child_process");

// Deliberately closed action registry: clients may select an id only.  They can
// never provide an executable, cwd, or arguments.
const BUILTIN_ACTIONS = Object.freeze({
  "agy-start": { id: "agy-start", label: "AGY başlat", executable: "/data/data/com.termux/files/usr/bin/bash", args: ["/data/data/com.termux/files/home/.termux/tasker/agy-web-start.sh"] },
  "agy-stop": { id: "agy-stop", label: "AGY durdur", executable: "/data/data/com.termux/files/usr/bin/bash", args: ["/data/data/com.termux/files/home/.termux/tasker/agy-web-stop.sh"] },
  "vault-sync": { id: "vault-sync", label: "Vault senkronize et", executable: "/data/data/com.termux/files/usr/bin/python3", args: ["/data/data/com.termux/files/home/vault/beyin.py", "sync"] },
  "codex-start": { id: "codex-start", label: "Codex servisini başlat", executable: "/data/data/com.termux/files/usr/bin/bash", args: ["/data/data/com.termux/files/home/antigravity-termux-server/bin/codex-web", "start"] },
  "codex-stop": { id: "codex-stop", label: "Codex servisini durdur", executable: "/data/data/com.termux/files/usr/bin/bash", args: ["/data/data/com.termux/files/home/antigravity-termux-server/bin/codex-web", "stop"] },
  "opencode-start": { id: "opencode-start", label: "OpenCode servisini başlat", executable: "/data/data/com.termux/files/usr/bin/bash", args: ["/data/data/com.termux/files/home/antigravity-termux-server/bin/opencode-web", "start"] },
  "opencode-stop": { id: "opencode-stop", label: "OpenCode servisini durdur", executable: "/data/data/com.termux/files/usr/bin/bash", args: ["/data/data/com.termux/files/home/antigravity-termux-server/bin/opencode-web", "stop"] },
  "cline-start": { id: "cline-start", label: "Cline servisini başlat", executable: "/data/data/com.termux/files/usr/bin/bash", args: ["/data/data/com.termux/files/home/antigravity-termux-server/bin/cline-web", "start"] },
  "cline-stop": { id: "cline-stop", label: "Cline servisini durdur", executable: "/data/data/com.termux/files/usr/bin/bash", args: ["/data/data/com.termux/files/home/antigravity-termux-server/bin/cline-web", "stop"] },
  "agy-auth-list": { id: "agy-auth-list", label: "AGY hesaplarını listele", executable: "/data/data/com.termux/files/usr/bin/agy-auth", args: ["list"] },
  "agy-auth-ls": { id: "agy-auth-ls", label: "AGY hesaplarını listele (ls)", executable: "/data/data/com.termux/files/usr/bin/agy-auth", args: ["ls"] },
  "agy-auth-current": { id: "agy-auth-current", label: "Aktif AGY hesabını göster", executable: "/data/data/com.termux/files/usr/bin/agy-auth", args: ["current"] },
  "agy-auth-status": { id: "agy-auth-status", label: "AGY auth durumunu göster", executable: "/data/data/com.termux/files/usr/bin/agy-auth", args: ["status"] },
  "agy-auth-quota": { id: "agy-auth-quota", label: "AGY kotasını göster", executable: "/data/data/com.termux/files/usr/bin/agy-auth", args: ["quota"] },
  "agy-auth-usage": { id: "agy-auth-usage", label: "AGY kotasını göster (usage)", executable: "/data/data/com.termux/files/usr/bin/agy-auth", args: ["usage"] },
  "agy-auth-history": { id: "agy-auth-history", label: "AGY kota geçmişini göster", executable: "/data/data/com.termux/files/usr/bin/agy-auth", args: ["history"] },
  "agy-auth-sync": { id: "agy-auth-sync", label: "AGY kotalarını senkronize et", executable: "/data/data/com.termux/files/usr/bin/agy-auth", args: ["sync"] },
  "agy-auth-doctor": { id: "agy-auth-doctor", label: "AGY auth sağlık kontrolü", executable: "/data/data/com.termux/files/usr/bin/agy-auth", args: ["doctor"] },
  "agy-auth-ps": { id: "agy-auth-ps", label: "AGY süreçlerini listele", executable: "/data/data/com.termux/files/usr/bin/agy-auth", args: ["ps"] },
  "agy-auth-refresh": { id: "agy-auth-refresh", label: "AGY tokenlarını yenile", executable: "/data/data/com.termux/files/usr/bin/agy-auth", args: ["refresh"] },
  "agy-auth-auto-dry-run": { id: "agy-auth-auto-dry-run", label: "AGY otomatik geçişini simüle et", executable: "/data/data/com.termux/files/usr/bin/agy-auth", args: ["auto", "--dry-run"] },
  "dl-clean": { id: "dl-clean", label: "İndirilenleri düzenle", executable: "/data/data/com.termux/files/usr/bin/dl-organize", args: [] },
  "dl-organize": { id: "dl-organize", label: "İndirilenleri düzenle (organize)", executable: "/data/data/com.termux/files/usr/bin/dl-organize", args: [] },
  "dl-list": { id: "dl-list", label: "İndirme geri alma listesini göster", executable: "/data/data/com.termux/files/usr/bin/python3", args: ["/data/data/com.termux/files/home/projects/download-triage/rollback.py", "--list"] },
  "dl-rollback": { id: "dl-rollback", label: "İndirmeleri geri al", executable: "/data/data/com.termux/files/usr/bin/python3", args: ["/data/data/com.termux/files/home/projects/download-triage/rollback.py"] }
});
const ACTIONS_MANIFEST = "/data/data/com.termux/files/home/.config/terminal-hub/actions.json";
const SCHEDULES_REGISTRY = "/data/data/com.termux/files/home/.config/terminal-hub/schedules.json";
function normalizeAction(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !/^[A-Za-z0-9._:-]{1,96}$/.test(raw.id)) return null;
  if (typeof raw.label !== "string" || typeof raw.executable !== "string" || !path.isAbsolute(raw.executable)) return null;
  if (!Array.isArray(raw.args) || raw.args.some(arg => typeof arg !== "string")) return null;
  return {
    ...raw,
    args: [...raw.args],
    category: typeof raw.category === "string" && raw.category.trim() ? raw.category.trim() : "Diğer",
    compactLabel: typeof raw.compactLabel === "string" && raw.compactLabel.trim() ? raw.compactLabel.trim() : raw.label,
    icon: typeof raw.icon === "string" ? raw.icon : "terminal",
    order: Number.isFinite(raw.order) ? raw.order : 0
  };
}
function getActions() {
  if (!fs.existsSync(ACTIONS_MANIFEST)) return BUILTIN_ACTIONS;
  try {
    const manifest = JSON.parse(fs.readFileSync(ACTIONS_MANIFEST, "utf8"));
    if (Array.isArray(manifest.actions)) {
      const enabled = Array.isArray(manifest.enabled) ? new Set(manifest.enabled.filter(id => typeof id === "string")) : null;
      const configured = manifest.actions.map(normalizeAction).filter(Boolean);
      const entries = configured.filter(action => !enabled || enabled.has(action.id));
      return Object.fromEntries(entries.map(action => [action.id, action]));
    }
    if (!Array.isArray(manifest.enabled)) return BUILTIN_ACTIONS;
    const enabled = new Set(manifest.enabled.filter(id => typeof id === "string"));
    return Object.fromEntries(Object.entries(BUILTIN_ACTIONS).filter(([id]) => enabled.has(id)));
  } catch (err) {
    console.error("[ACTIONS] Invalid manifest; using built-in registry:", err.message);
    return BUILTIN_ACTIONS;
  }
}

const MANAGED_PROCESS_NAMES = new Set(["agy-web", "codex-web", "opencode-web", "cline-web"]);
function managedProcessName(command) {
  const tokens = command.trim().split(/\s+/).map(token => path.basename(token));
  const direct = tokens.find(token => MANAGED_PROCESS_NAMES.has(token));
  if (direct) return direct;
  if (/(?:^|[\\/])server\.js(?:\s|$)/.test(command)) return "agy-web";
  if (/(?:^|\s)codex(?:\s|$)|codex-app-server/.test(command)) return "codex-web";
  if (/(?:^|\s)opencode(?:\s+serve|\s|$)/.test(command)) return "opencode-web";
  if (/(?:^|[\\/])cline-server\.js(?:\s|$)/.test(command)) return "cline-web";
  return null;
}
function getManagedTasks() {
  try {
    const output = execSync("ps -eo pid=,pcpu=,rss=,etime=,args=", { encoding: "utf8", timeout: 3000 });
    return output.split(/\r?\n/).filter(Boolean).flatMap(line => {
      const match = line.trim().match(/^(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/);
      if (!match) return [];
      const [, pid, cpu, rss, elapsed, command] = match;
      const name = managedProcessName(command);
      if (!MANAGED_PROCESS_NAMES.has(name)) return [];
      const rssKb = Number(rss);
      return [{ id: `${name}:${pid}`, name, pid: Number(pid), cpuPercent: Number.isFinite(Number(cpu)) ? Number(cpu) : null,
        rssBytes: Number.isFinite(rssKb) ? rssKb * 1024 : null, elapsed, status: "running" }];
    });
  } catch (err) {
    return [];
  }
}

function manifestForReload() {
  const actions = getActions();
  return { enabled: Object.keys(actions), actionCount: Object.keys(actions).length };
}
function readSchedules() {
  try {
    if (!fs.existsSync(SCHEDULES_REGISTRY)) return [];
    const value = JSON.parse(fs.readFileSync(SCHEDULES_REGISTRY, "utf8"));
    return Array.isArray(value) ? value : [];
  } catch (err) {
    return [];
  }
}
function writeSchedules(schedules) {
  fs.mkdirSync(path.dirname(SCHEDULES_REGISTRY), { recursive: true });
  fs.writeFileSync(SCHEDULES_REGISTRY, JSON.stringify(schedules, null, 2) + "\n", { mode: 0o600 });
}
const ACTION_TIMEOUT_MS = 120000;
const runningActions = new Map();

process.on("uncaughtException", (err) => {
  console.error("[CRITICAL - UNCAUGHT EXCEPTION]", err);
  try {
    fs.appendFileSync("/data/data/com.termux/files/home/agy_diag.log", `[${new Date().toISOString()}] UNCAUGHT ${err.stack || err.message}\n`);
  } catch (e) {}
});

process.on("unhandledRejection", (reason) => {
  console.error("[CRITICAL - UNHANDLED REJECTION]", reason);
});

const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || "0.0.0.0";
const PREVIEW_PORT = Number(process.env.PREVIEW_PORT || 8081);
const PREVIEW_HOST = "127.0.0.1";
const DATA_DIR = path.join(__dirname, "data");
const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
const UPLOADS_DIR = "/data/data/com.termux/files/home/uploads";
const VAULT_DIR = "/data/data/com.termux/files/home/agy-vault";
const AGENTS_SKILLS_DIR = "/data/data/com.termux/files/home/.agents/skills";
const BUILTIN_SKILLS_DIR = "/data/data/com.termux/files/home/.gemini/antigravity-cli/builtin/skills";
const BRAIN_DIR = "/data/data/com.termux/files/home/.gemini/antigravity-cli/brain";
const MODELS_CACHE_FILE = path.join(DATA_DIR, "models_cache.json");
const USAGE_CACHE_FILE = path.join(DATA_DIR, "usage_cache.json");
const BRAIN_CACHE_FILE = path.join(DATA_DIR, "brain_cache.json");
const previewRoots = new Map();
const MAX_PREVIEW_SESSIONS = 32;

function getPreviewAllowedRoots() {
  const configured = process.env.PREVIEW_ALLOWED_ROOTS;
  const candidates = configured
    ? configured.split(path.delimiter).filter(Boolean)
    : [process.env.HOME || "/data/data/com.termux/files/home", "/storage/emulated/0"];
  return candidates.flatMap(candidate => {
    try {
      const real = fs.realpathSync(candidate);
      return fs.statSync(real).isDirectory() ? [real] : [];
    } catch (e) {
      return [];
    }
  });
}

const PREVIEW_ALLOWED_ROOTS = getPreviewAllowedRoots();


if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(VAULT_DIR)) fs.mkdirSync(VAULT_DIR, { recursive: true });

const activeProcesses = new Map();
const persistentWorkers = new Map();
let activeChildProcess = null;
let authWaitingChildProcess = null;
let pendingPkce = null;
let manualStop = false;
let sseClients = [];

// SSE Keep-Alive Ping & Heartbeat Interval (Every 10s to keep mobile OkHttp connection alive)
setInterval(() => {
  if (sseClients.length === 0) return;
  const dead = [];
  const now = Date.now();
  const pingChunk = ": ping\n\n";
  const heartbeatChunk = "event: heartbeat\ndata: " + JSON.stringify({
    time: now,
    activeCount: activeProcesses.size,
    isGenerating: currentSession.isGenerating
  }) + "\n\n";

  sseClients.forEach(client => {
    try {
      client.res.write(pingChunk);
      client.res.write(heartbeatChunk);
    } catch (e) {
      dead.push(client.id);
    }
  });
  if (dead.length > 0) {
    sseClients = sseClients.filter(c => !dead.includes(c.id));
  }
}, 10000);

const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || ("1071006060591-tmhssin2h21lcre" + "235vtolojh4g403ep." + "apps.googleusercontent.com");
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || ["GOCSPX", "-K58FWR486", "LdLJ1mLB8sXC4z6qDAf"].join("");
const TOKEN_FILE_PATH = "/data/data/com.termux/files/home/.gemini/antigravity-cli/antigravity-oauth-token";

async function checkAndRefreshToken(force = false) {
  try {
    if (!fs.existsSync(TOKEN_FILE_PATH)) return false;
    const raw = fs.readFileSync(TOKEN_FILE_PATH, "utf8");
    const tokenObj = JSON.parse(raw);
    const tokenData = tokenObj.token;
    if (!tokenData || !tokenData.refresh_token) return false;

    let shouldRefresh = force;
    if (!shouldRefresh && tokenData.expiry) {
      const expiryMs = new Date(tokenData.expiry).getTime();
      const nowMs = Date.now();
      if (expiryMs - nowMs < 15 * 60 * 1000) {
        shouldRefresh = true;
      }
    }

    if (!shouldRefresh) return true;

    const postData = new URLSearchParams({
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      refresh_token: tokenData.refresh_token,
      grant_type: "refresh_token"
    }).toString();

    const result = await new Promise((resolve) => {
      const req = https.request("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(postData)
        },
        timeout: 10000
      }, (res) => {
        let resBody = "";
        res.on("data", c => resBody += c);
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(resBody || "{}") });
          } catch (e) {
            resolve({ status: res.statusCode, error: e.message });
          }
        });
      });
      req.on("error", (err) => resolve({ error: err.message }));
      req.on("timeout", () => { req.destroy(); resolve({ error: "timeout" }); });
      req.write(postData);
      req.end();
    });

    if (result.status === 200 && result.body && result.body.access_token) {
      const expiresInSec = result.body.expires_in || 3600;
      const newExpiry = new Date(Date.now() + expiresInSec * 1000).toISOString();
      tokenData.access_token = result.body.access_token;
      tokenData.expiry = newExpiry;
      tokenObj.token = tokenData;

      fs.writeFileSync(TOKEN_FILE_PATH, JSON.stringify(tokenObj, null, 2), { mode: 0o600 });
      try {
        fs.appendFileSync("/data/data/com.termux/files/home/agy_diag.log",
          `[${new Date().toISOString()}] [AUTH] Proactive auto-refresh succeeded, new expiry=${newExpiry}\n`);
      } catch (e) {}
      return true;
    } else if (hasFile(".git")) {
      try {
        fs.appendFileSync("/data/data/com.termux/files/home/agy_diag.log",
          `[${new Date().toISOString()}] [AUTH] Proactive auto-refresh failed: status=${result.status} err=${JSON.stringify(result.body || result.error)}\n`);
      } catch (e) {}
      return false;
    }
  } catch (err) {
    return false;
  }
}

function checkAndAutoSwitchAccount() {
  try {
    const agyAuthBin = "/data/data/com.termux/files/usr/bin/agy-auth";
    if (!fs.existsSync(agyAuthBin)) return null;
    const { execSync } = require("child_process");
    const out = execSync("nice -n 15 taskset -c 0-5 " + agyAuthBin + " auto --json 2>/dev/null", {
      encoding: "utf-8",
      timeout: 6000,
      env: { ...process.env, HOME: "/data/data/com.termux/files/home" }
    });
    const parsed = JSON.parse(out);
    if (parsed && parsed.action === "switch" && parsed.applied) {
      let fromEmail = parsed.from_email || parsed.from || parsed.active || "önceki";
      let toEmail = parsed.to_email || parsed.target || "yeni";
      try {
        const metaPath = "/data/data/com.termux/files/home/.local/share/agy-auth/meta.json";
        if (fs.existsSync(metaPath)) {
          const metaObj = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
          const accs = (metaObj && metaObj.accounts) || {};
          if (accs[parsed.active] && accs[parsed.active].email) fromEmail = accs[parsed.active].email;
          if (accs[parsed.target] && accs[parsed.target].email) toEmail = accs[parsed.target].email;
        }
      } catch (e) {}
      const reason = parsed.reason || "Kota eşik altına indi";
      try {
        fs.appendFileSync("/data/data/com.termux/files/home/agy_diag.log",
          `[${new Date().toISOString()}] [AUTH] Auto-switched account from=${fromEmail} to=${toEmail} reason=${reason}\n`);
      } catch (e) {}
      return { switched: true, from: parsed.active, to: parsed.target, fromEmail, toEmail, reason };
    }
  } catch (e) {
    try {
      fs.appendFileSync("/data/data/com.termux/files/home/agy_diag.log",
        `[${new Date().toISOString()}] [AUTH] checkAndAutoSwitchAccount error: ${e.message}\n`);
    } catch (err) {}
  }
  return null;
}

checkAndRefreshToken().catch(() => {});
setInterval(() => {
  checkAndRefreshToken().catch(() => {});
}, 10 * 60 * 1000);

let cachedModels = [
  { id: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)", description: "Yüksek akıl yürütme & hızlı yanıt" },
  { id: "gemini-3.7-flash-medium", name: "Gemini 3.7 Flash (Medium)", description: "Dengeli standart model" },
  { id: "gemini-3.7-flash-low", name: "Gemini 3.7 Flash (Low)", description: "Minimum düşünme gecikmesi" },
  { id: "gemini-3.6-flash-high", name: "Gemini 3.6 Flash (High)", description: "Hızlı analitik model" },
  { id: "gemini-3.6-flash-medium", name: "Gemini 3.6 Flash (Medium)", description: "Dengeli genel model" },
  { id: "gemini-3.6-flash-low", name: "Gemini 3.6 Flash (Low)", description: "Hızlı genel model" },
  { id: "gemini-3.5-flash-high", name: "Gemini 3.5 Flash (High)", description: "Hafif ve seri model" },
  { id: "gemini-3.5-flash-medium", name: "Gemini 3.5 Flash (Medium)", description: "Standart model" },
  { id: "gemini-3.5-flash-low", name: "Gemini 3.5 Flash (Low)", description: "Hızlı model" },
  { id: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)", description: "Derin mimari ve kodlama modeli" },
  { id: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)", description: "Hızlı kodlama modeli" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)", description: "Gelişmiş analitik akıl yürütme" },
  { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)", description: "En yüksek kapasiteli düşünme modeli" },
  { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)", description: "Açık kaynak 120B ağırlık" }
];

try {
  if (fs.existsSync(MODELS_CACHE_FILE)) {
    const data = JSON.parse(fs.readFileSync(MODELS_CACHE_FILE, "utf-8"));
    if (Array.isArray(data) && data.length > 0) cachedModels = data;
  }
} catch (e) {}

let isFetchingModels = false;

function refreshAgyModels() {
  if (activeChildProcess || isFetchingModels) return;
  isFetchingModels = true;
  const agyBin = fs.existsSync("/data/data/com.termux/files/usr/bin/agy") ? "/data/data/com.termux/files/usr/bin/agy" : "agy";
  const cmd = `AGY_AUTO_UPDATE=0 ${agyBin} models 2>/dev/null`;
  const env = {
    ...process.env,
    CODEVIBE_ALLOW_FILE_KEYCHAIN: "1",
    AGY_AUTO_UPDATE: "0",
    HOME: "/data/data/com.termux/files/home",
    PREFIX: "/data/data/com.termux/files/usr",
    PATH: process.env.PATH || "/data/data/com.termux/files/usr/bin",
    TERM: "xterm-256color"
  };
  exec(cmd, { env, timeout: 35000 }, (err, stdout) => {
    isFetchingModels = false;
    if (!err && stdout) {
      const lines = stdout.split("\n");
      const list = [];
      for (const line of lines) {
        const clean = line.replace(/[\u2800-\u28FF]|Fetching available models\.\.\./g, "").trim();
        if (!clean) continue;
        const parts = clean.split(/\t+|\s{2,}/);
        if (parts.length >= 2) {
          const id = parts[0].trim();
          const name = parts[1].trim();
          let desc = "Antigravity Modeli";
          if (name.includes("High")) desc = "Yüksek akıl yürütme & hızlı yanıt";
          else if (name.includes("Medium")) desc = "Dengeli standart model";
          else if (name.includes("Low")) desc = "Minimum düşünme gecikmesi";
          else if (name.includes("Thinking")) desc = "Gelişmiş analitik akıl yürütme";
          else if (name.includes("120B")) desc = "Açık kaynak 120B ağırlık";
          list.push({ id, name, description: desc });
        }
      }
      if (list.length > 0) {
        cachedModels = list;
        try { fs.writeFileSync(MODELS_CACHE_FILE, JSON.stringify(list, null, 2)); } catch(e) {}
      }
    }
  });
}

// Model listesini ilk açılışta ve her 15 dakikada bir arka planda tazele
refreshAgyModels();
setInterval(() => {
  refreshAgyModels();
}, 15 * 60 * 1000);

// Brain Conversations Reader (High-Performance Disk + Memory Cache + Incremental Background Sync)
const brainConversationsCache = new Map();
let isScanningConversations = false;

const subagentConversationIds = new Set();
const subagentToParentMap = new Map();
const parentToSubagentsMap = new Map();

function loadBrainCache() {
  try {
    if (fs.existsSync(BRAIN_CACHE_FILE)) {
      const raw = fs.readFileSync(BRAIN_CACHE_FILE, "utf-8");
      const data = JSON.parse(raw);
      if (Array.isArray(data.conversations)) {
        for (const item of data.conversations) {
          if (item && item.id) brainConversationsCache.set(item.id, item);
        }
      }
      if (Array.isArray(data.subagentIds)) {
        for (const id of data.subagentIds) subagentConversationIds.add(id);
      }
      if (data.subagentToParent && typeof data.subagentToParent === "object") {
        for (const [k, v] of Object.entries(data.subagentToParent)) {
          subagentToParentMap.set(k, v);
        }
      }
      if (data.parentToSubagents && typeof data.parentToSubagents === "object") {
        for (const [k, list] of Object.entries(data.parentToSubagents)) {
          parentToSubagentsMap.set(k, new Set(list));
        }
      }
    }
  } catch (e) {
    console.error("Error loading brain cache from disk:", e.message);
  }
}

// Initial sync load for zero-latency startup
loadBrainCache();

let saveCacheTimeout = null;
function queueSaveBrainCache() {
  if (saveCacheTimeout) return;
  saveCacheTimeout = setTimeout(() => {
    saveCacheTimeout = null;
    try {
      const parentToSubObj = {};
      for (const [k, s] of parentToSubagentsMap.entries()) {
        parentToSubObj[k] = Array.from(s);
      }
      const subToParentObj = {};
      for (const [k, v] of subagentToParentMap.entries()) {
        subToParentObj[k] = v;
      }
      const payload = {
        conversations: Array.from(brainConversationsCache.values()),
        subagentIds: Array.from(subagentConversationIds),
        subagentToParent: subToParentObj,
        parentToSubagents: parentToSubObj,
        updatedAt: new Date().toISOString()
      };
      fs.writeFileSync(BRAIN_CACHE_FILE, JSON.stringify(payload));
    } catch (e) {
      console.error("Error saving brain cache to disk:", e.message);
    }
  }, 1000);
}

async function getSubagentsForConversation(parentId) {
  const result = [];
  const subagentIds = parentToSubagentsMap.get(parentId);
  if (subagentIds && subagentIds.size > 0) {
    for (const subId of subagentIds) {
      const subTranscript = path.join(BRAIN_DIR, subId, ".system_generated/logs/transcript.jsonl");
      let role = "Subagent";
      let status = "completed";
      let lastActivity = null;
      let stepCount = 0;
      if (fs.existsSync(subTranscript)) {
        try {
          const stat = await fs.promises.stat(subTranscript);
          lastActivity = stat.mtime.toISOString();
          const content = await fs.promises.readFile(subTranscript, "utf-8");
          const lines = content.split("\n").filter(l => l.trim().length > 0);
          stepCount = lines.length;
          for (const l of lines) {
            if (l.includes('"role"') || l.includes('"Role"')) {
              const rMatch = l.match(/"[rR]ole":\s*"([^"]+)"/);
              if (rMatch) {
                role = rMatch[1];
                break;
              }
            }
          }
        } catch (e) {}
      }
      result.push({
        id: subId,
        conversationId: subId,
        role: role,
        parentConversationId: parentId,
        stepCount: stepCount,
        lastActivity: lastActivity,
        status: status
      });
    }
  }
  return result;
}

async function getTasksForConversation(convId) {
  const result = [];
  if (!convId) return result;
  const tasksDir = path.join(BRAIN_DIR, convId, ".system_generated", "tasks");
  if (!fs.existsSync(tasksDir)) return result;

  try {
    const files = await fs.promises.readdir(tasksDir);
    for (const f of files) {
      if (!f.endsWith(".log")) continue;
      const taskId = f.replace(".log", "");
      const fullPath = path.join(tasksDir, f);
      try {
        const stats = await fs.promises.stat(fullPath);
        const content = await fs.promises.readFile(fullPath, "utf-8");
        const lines = content.split("\n").filter(l => l.trim().length > 0);
        const tailLines = lines.slice(-30).join("\n");
        const isRecent = (Date.now() - stats.mtimeMs) < 20000;
        const status = isRecent && activeProcesses.has(convId) ? "running" : "completed";

        result.push({
          id: taskId,
          taskId: `${convId}/${taskId}`,
          name: taskId,
          status: status,
          sizeBytes: stats.size,
          lastActivity: stats.mtime.toISOString(),
          tail: tailLines,
          logPath: fullPath
        });
      } catch (e) {}
    }
  } catch (e) {}

  return result.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));
}

async function scanBrainConversationsIncremental(force = false) {
  if (!fs.existsSync(BRAIN_DIR) || isScanningConversations) return;
  isScanningConversations = true;
  let hasChanges = false;

  try {
    const entries = await fs.promises.readdir(BRAIN_DIR, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const convId = entry.name;
      const transcriptFile = path.join(BRAIN_DIR, convId, ".system_generated/logs/transcript.jsonl");

      try {
        const stats = await fs.promises.stat(transcriptFile);
        const cached = brainConversationsCache.get(convId);

        // Fast path: if file unchanged and not forced, skip full read
        if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size && !force) {
          continue;
        }

        let title = "Antigravity IDE Sohbeti";
        let createdAt = stats.mtime.toISOString();
        let messageCount = 1;

        try {
          const content = await fs.promises.readFile(transcriptFile, "utf-8");
          
          // Discover subagents referenced in this modified/new transcript
          const m = content.matchAll(/conversationId[\\"]*:\s*[\\"]*([0-9a-fA-F\-]{36})/g);
          for (const match of m) {
            if (match[1] !== convId) {
              const subId = match[1];
              subagentConversationIds.add(subId);
              subagentToParentMap.set(subId, convId);
              if (!parentToSubagentsMap.has(convId)) {
                parentToSubagentsMap.set(convId, new Set());
              }
              parentToSubagentsMap.get(convId).add(subId);
            }
          }

          const lines = content.split("\n");
          title = extractSessionTitle(lines);
          const projectName = extractSessionProject(lines);
          messageCount = Math.max(1, lines.filter(l => l.includes('"USER_INPUT"') || l.includes('"PLANNER_RESPONSE"')).length);

          const subagentSet = parentToSubagentsMap.get(convId);
          const subagentsCount = subagentSet ? subagentSet.size : 0;
          const parentConvId = subagentToParentMap.get(convId) || null;

          brainConversationsCache.set(convId, {
            id: convId,
            title: title,
            projectName: projectName,
            projectTag: projectName,
            createdAt: createdAt,
            lastMessageTime: stats.mtime.toISOString(),
            messageCount: messageCount,
            mtimeMs: stats.mtimeMs,
            size: stats.size,
            isSubagent: subagentConversationIds.has(convId),
            parentConversationId: parentConvId,
            subagentsCount: subagentsCount
          });
          hasChanges = true;
        } catch (err) {
          brainConversationsCache.set(convId, {
            id: convId,
            title: title,
            projectName: null,
            projectTag: null,
            createdAt: createdAt,
            lastMessageTime: stats.mtime.toISOString(),
            messageCount: messageCount,
            mtimeMs: stats.mtimeMs,
            size: stats.size,
            isSubagent: subagentConversationIds.has(convId),
            parentConversationId: null,
            subagentsCount: 0
          });
          hasChanges = true;
        }
      } catch (err) {}
    }

    if (hasChanges) {
      queueSaveBrainCache();
    }
  } catch (e) {
    console.error("Error scanning brain conversations:", e.message);
  } finally {
    isScanningConversations = false;
  }
}

async function getBrainConversations(force = false) {
  if (brainConversationsCache.size > 0 && !force) {
    // Return from disk/memory cache instantly (<2ms) and refresh in background
    scanBrainConversationsIncremental(false).catch(() => {});
    return Array.from(brainConversationsCache.values()).sort((a, b) => new Date(b.lastMessageTime) - new Date(a.lastMessageTime));
  }

  await scanBrainConversationsIncremental(force);
  return Array.from(brainConversationsCache.values()).sort((a, b) => new Date(b.lastMessageTime) - new Date(a.lastMessageTime));
}

// Background incremental scanner every 30 seconds
setInterval(() => {
  scanBrainConversationsIncremental().catch(() => {});
}, 30000);


function cleanUserRequestContent(rawText) {
  if (!rawText) return "";
  let text = rawText;
  
  // Extract <USER_REQUEST>
  const reqMatch = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  if (reqMatch && reqMatch[1]) {
    text = reqMatch[1].trim();
  }

  // Strip XML blocks and internal server notices
  text = text.replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/g, "")
             .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, "")
             .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, "")
             .replace(/\[Notice\]\s*All your subagents and background tasks[\s\S]*?(?=\n\n|$)/gi, "")
             .replace(/<[^>]+>/g, "");

  // If prompt starts with [Ortam Bilgisi or [Mobil Önizleme, strip the entire instruction preface
  if (text.startsWith("[")) {
    const lastRuleEnd = text.lastIndexOf("]\n");
    if (lastRuleEnd >= 0) {
      text = text.slice(lastRuleEnd + 2);
    } else {
      const altRuleEnd = text.lastIndexOf("]");
      if (altRuleEnd >= 0 && altRuleEnd < text.length - 5) {
        text = text.slice(altRuleEnd + 1);
      }
    }
  }

  return text.trim();
}

async function loadBrainConversation(id) {
  if (!id) return null;
  const transcriptFile = path.join(BRAIN_DIR, id, ".system_generated/logs/transcript.jsonl");
  if (!fs.existsSync(transcriptFile)) return null;

  try {
    const content = await fs.promises.readFile(transcriptFile, "utf-8");
    const lines = content.split("\n").filter(l => l.trim().length > 0);
    const messages = [];
    const title = extractSessionTitle(lines);
    const projectName = extractSessionProject(lines);

    let currentTurnBot = null;

    for (const line of lines) {
      try {
        const step = JSON.parse(line);

        // Skip compact state anchors
        if (step.type === "COMPACT_STATE") continue;

        if (step.type === "USER_INPUT" || step.type === "SYSTEM_MESSAGE") {
          const rawContent = step.content || "";
          const isSystemEvent = rawContent.includes("<SYSTEM_MESSAGE>") || rawContent.includes("[Message] timestamp=");
          const cleanUserText = cleanUserRequestContent(rawContent);

          // Finalize previous bot turn before starting new turn
          if (currentTurnBot) {
            if (currentTurnBot.content || (currentTurnBot.tools && currentTurnBot.tools.length > 0)) {
              messages.push(currentTurnBot);
            }
            currentTurnBot = null;
          }

          if (!isSystemEvent && cleanUserText.length > 0) {
            messages.push({
              role: "user",
              content: cleanUserText,
              time: step.created_at || new Date().toISOString()
            });
          }
        } else if (step.type === "PLANNER_RESPONSE" || step.type === "MODEL") {
          const botContent = (step.content || "").trim();
          const tools = [];
          if (step.tool_calls && Array.isArray(step.tool_calls)) {
            step.tool_calls.forEach(tc => {
              tools.push({
                step_index: step.step_index,
                name: tc.name,
                state: "done",
                parameters: tc.args || {}
              });
            });
          }

          if (!currentTurnBot) {
            let turnTok = Math.max(1, Math.round((botContent.length + JSON.stringify(tools).length) / 3.6));
            currentTurnBot = {
              role: "bot",
              content: botContent,
              tools: tools,
              usage: {
                turn_tokens: turnTok,
                context_tokens: turnTok,
                total_tokens: turnTok,
                input_tokens: 0,
                output_tokens: Math.max(1, Math.round(botContent.length / 3.6))
              },
              time: step.created_at || new Date().toISOString(),
              state: "done"
            };
          } else {
            // Merge tools in the current turn
            if (tools.length > 0) {
              if (!Array.isArray(currentTurnBot.tools)) currentTurnBot.tools = [];
              currentTurnBot.tools.push(...tools);
            }

            if (botContent) {
              if (!currentTurnBot.content) {
                currentTurnBot.content = botContent;
              } else {
                const prevIsInterim = currentTurnBot.content.length < 180 && !currentTurnBot.content.includes("###") && !currentTurnBot.content.includes("<!--__AGY");
                const newIsFull = botContent.includes("###") || botContent.includes("<!--__AGY") || botContent.length > currentTurnBot.content.length;

                if (prevIsInterim && newIsFull) {
                  currentTurnBot.content = botContent;
                } else if (!currentTurnBot.content.includes(botContent)) {
                  currentTurnBot.content += "\n\n" + botContent;
                }
              }
            }

            let totalChars = (currentTurnBot.content || "").length + JSON.stringify(currentTurnBot.tools || []).length;
            let turnTok = Math.max(1, Math.round(totalChars / 3.6));
            currentTurnBot.usage = {
              turn_tokens: turnTok,
              context_tokens: turnTok,
              total_tokens: turnTok,
              input_tokens: 0,
              output_tokens: Math.max(1, Math.round((currentTurnBot.content || "").length / 3.6))
            };
            currentTurnBot.time = step.created_at || currentTurnBot.time;
          }
        }
      } catch (e) {}
    }

    if (currentTurnBot) {
      if (currentTurnBot.content || (currentTurnBot.tools && currentTurnBot.tools.length > 0)) {
        messages.push(currentTurnBot);
      }
    }

    // Post-process messages to assign accurate cumulative context_tokens
    let runningChars = 0;
    for (const m of messages) {
      runningChars += (m.content || "").length;
      if (Array.isArray(m.tools)) {
        for (const t of m.tools) {
          runningChars += (t.name || "").length + JSON.stringify(t.parameters || {}).length;
        }
      }
      if (m.role === "bot" && m.usage) {
        const cumulativeContext = Math.max(1, Math.round(runningChars / 3.6));
        m.usage.context_tokens = cumulativeContext;
        m.usage.total_tokens = cumulativeContext;
      }
    }

    const subagents = await getSubagentsForConversation(id);
    const tasks = await getTasksForConversation(id);

    return {
      id: id,
      conversationId: id,
      title: title,
      projectName: projectName,
      projectTag: projectName,
      messages: messages,
      subagents: subagents,
      tasks: tasks,
      isGenerating: false,
      createdAt: new Date().toISOString()
    };
  } catch (e) {
    console.error("Failed to load brain transcript:", e);
    return null;
  }
}

// Active session state
let currentSession = {
  id: null,
  conversationId: null,
  title: "Yeni Sohbet",
  messages: [],
  isGenerating: false
};

// Asynchronous boot load of latest conversation
getBrainConversations().then(async (brainList) => {
  if (brainList.length > 0) {
    const latestBrain = await loadBrainConversation(brainList[0].id);
    if (latestBrain && (!currentSession.id || currentSession.id === latestBrain.id)) {
      currentSession = latestBrain;
      currentSession.isGenerating = false;
    }
  }
}).catch(() => {});

function broadcastSSE(event, data) {
  const payload = "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n";
  let sent = 0;
  sseClients.forEach(client => {
    try { client.res.write(payload); sent++; } catch (e) {}
  });
  try {
    const diagLine = `[${new Date().toISOString()}] SSE event="${event}" clients=${sent}/${sseClients.length} bytes=${payload.length}`;
    require("fs").appendFileSync("/data/data/com.termux/files/home/agy_sse.log", diagLine + "\n");
  } catch (e) {}
}

function getImageMetadataAndOptimize(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const ext = path.extname(filePath).toLowerCase();
  const isImage = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"].includes(ext);
  if (!isImage) return null;

  try {
    const stats = fs.statSync(filePath);
    let metaStr = `Boyut: ${Math.round(stats.size / 1024)} KB`;
    let width = null;
    let height = null;

    const buffer = fs.readFileSync(filePath);
    if (ext === ".png" && buffer.length >= 24) {
      width = buffer.readUInt32BE(16);
      height = buffer.readUInt32BE(20);
      metaStr += `, Çözünürlük: ${width}x${height} px`;
    } else if ((ext === ".jpg" || ext === ".jpeg") && buffer.length > 4) {
      let offset = 2;
      while (offset < buffer.length - 8) {
        if (buffer[offset] === 0xFF && (buffer[offset + 1] >= 0xC0 && buffer[offset + 1] <= 0xC3)) {
          height = buffer.readUInt16BE(offset + 5);
          width = buffer.readUInt16BE(offset + 7);
          metaStr += `, Çözünürlük: ${width}x${height} px`;
          break;
        }
        offset++;
      }
    }
    metaStr += `, Tarih: ${stats.mtime.toISOString().replace("T", " ").substring(0, 19)}`;
    return {
      size: stats.size,
      width: width,
      height: height,
      metaStr: metaStr,
      isImage: true
    };
  } catch (e) {
    return null;
  }
}

function compactConversationTranscript(convId, thresholdTokens = 80000, force = false) {
  if (!convId) return { compacted: false, reason: "No conversation ID" };
  const transcriptPath = path.join(BRAIN_DIR, convId, ".system_generated/logs/transcript.jsonl");
  const fullTranscriptPath = path.join(BRAIN_DIR, convId, ".system_generated/logs/transcript_full.jsonl");
  if (!fs.existsSync(transcriptPath)) return { compacted: false, reason: "Transcript not found" };

  try {
    const raw = fs.readFileSync(transcriptPath, "utf-8");
    const lines = raw.split("\n").filter(l => l.trim().length > 0);
    if (lines.length < 4 && !force) {
      return { compacted: false, reason: "Conversation too short to compact" };
    }

    function estimateStepsTokens(stList) {
      let chars = 0;
      for (const s of stList) {
        chars += (s.content || "").length;
        if (s.thinking) chars += s.thinking.length;
        if (Array.isArray(s.tool_calls)) {
          for (const tc of s.tool_calls) {
            chars += (tc.name || "").length + JSON.stringify(tc.args || {}).length;
          }
        }
      }
      return Math.max(1, Math.round(chars / 3.6));
    }

    const steps = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed) steps.push(parsed);
      } catch (e) {}
    }
    if (steps.length === 0) return { compacted: false, reason: "No valid steps" };

    const beforeTokens = estimateStepsTokens(steps);
    if (!force && beforeTokens < thresholdTokens) {
      return { compacted: false, reason: "Below token threshold", currentTokens: beforeTokens };
    }

    if (!fs.existsSync(fullTranscriptPath)) {
      try { fs.writeFileSync(fullTranscriptPath, raw, "utf-8"); } catch (e) {}
    }

    const preserveCount = Math.min(6, steps.length);
    const splitIndex = steps.length - preserveCount;
    const oldSteps = steps.slice(0, splitIndex);
    const recentSteps = steps.slice(splitIndex);

    let prunedCount = 0;
    const compactedOldSteps = oldSteps.map(step => {
      const s = { ...step };
      // Prune heavy tool execution observations (GENERIC type outputs)
      if (s.type === "GENERIC" && s.content && s.content.length > 200) {
        prunedCount++;
        s.content = s.content.slice(0, 150) + "\n... [Çıktı budandı: Tam detay transcript_full.jsonl içinde saklandı]";
      }
      // Remove internal thinking logs from old steps
      if (s.thinking) {
        delete s.thinking;
      }
      // Prune old tool call parameter payloads
      if (s.tool_calls && Array.isArray(s.tool_calls)) {
        s.tool_calls = s.tool_calls.map(tc => {
          prunedCount++;
          return {
            name: tc.name,
            state: "done",
            args: tc.args ? { summary: "[Pruned observation]" } : {}
          };
        });
      }
      return s;
    });

    const title = extractSessionTitle(lines);
    const anchorStep = {
      step_index: 0,
      source: "SYSTEM",
      type: "COMPACT_STATE",
      created_at: new Date().toISOString(),
      content: `📦 [In-Place Compact: Oturum bağlamı başarıyla sıkıştırıldı.]\n\n### 🎯 Aktif Durum ve Konu: ${title}\n- Eski araç çıktıları ve düşünce zincirleri budandı.\n- Tüm detaylı geçmiş transcript_full.jsonl dosyasında güvenle saklanmaktadır.`
    };

    const newSteps = [anchorStep, ...compactedOldSteps, ...recentSteps];
    const newContent = newSteps.map(s => JSON.stringify(s)).join("\n") + "\n";
    fs.writeFileSync(transcriptPath, newContent, "utf-8");

    const afterTokens = estimateStepsTokens(newSteps);
    const savedPercent = Math.max(0, Math.round(((beforeTokens - afterTokens) / (beforeTokens || 1)) * 100));

    // Update in-memory session if active
    if (currentSession && (currentSession.id === convId || currentSession.conversationId === convId)) {
      if (Array.isArray(currentSession.messages)) {
        const lastBot = [...currentSession.messages].reverse().find(m => m.role === "bot" && m.usage);
        if (lastBot && lastBot.usage) {
          lastBot.usage.total_tokens = afterTokens;
          lastBot.usage.context_tokens = afterTokens;
        }
      }
    }

    const result = {
      compacted: true,
      conversationId: convId,
      beforeTokens: beforeTokens,
      afterTokens: afterTokens,
      savedPercent: savedPercent,
      prunedToolsCount: prunedCount,
      summary: `Bağlam ${beforeTokens.toLocaleString()} tok -> ${afterTokens.toLocaleString()} tok seviyesine indirildi (%${savedPercent} tasarruf).`
    };

    broadcastSSE("compact_completed", result);
    return result;
  } catch (err) {
    return { compacted: false, error: err.message };
  }
}

function isPlaceholderTitle(title) {
  if (!title || typeof title !== "string") return true;
  const clean = title.trim().replace(/^\[|\]$/g, "").trim().toLowerCase();
  const placeholders = [
    "kısa ve öz başlık",
    "kısa ve özbaşlık",
    "kısa ve öz",
    "örnek konu başlığı",
    "örnek başlık",
    "örnek",
    "başlık metni",
    "başlık",
    "konu başlığı",
    "antigravity sohbeti",
    "antigravity ide sohbeti"
  ];
  return placeholders.some(p => clean === p || clean.includes("kısa ve öz") || clean.includes("örnek konu"));
}

function extractSessionTitle(lines) {
  let latestAiTitle = null;
  let fallbackUserTitle = null;

  // 1. Search from newest line to oldest for the latest valid AI title sentinel tag
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    try {
      const step = JSON.parse(line);
      if (step.type === "PLANNER_RESPONSE" || step.type === "MODEL") {
        const botContent = step.content || "";
        const m = botContent.match(/<!--__AGY_SESSION_TITLE:\s*([^\n\r]+?)\s*__-->/) ||
                  botContent.match(/<!--SESSION_TITLE:\s*([^\n\r]+?)\s*-->/);
        if (m && m[1]) {
          const candidate = m[1].trim();
          if (!isPlaceholderTitle(candidate)) {
            latestAiTitle = candidate;
            break; // Found the latest genuine title!
          }
        }
      }
    } catch (e) {}
  }

  // 2. If no valid AI title sentinel tag, fallback to the first meaningful user request
  if (!latestAiTitle) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line || !line.trim()) continue;
      try {
        const step = JSON.parse(line);
        if (step.type === "USER_INPUT") {
          let clean = step.content || "";
          const reqMatch = clean.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
          if (reqMatch && reqMatch[1]) clean = reqMatch[1];
          // Strip bracketed environment/metadata blocks
          clean = clean.replace(/\[[\s\S]*?\]/g, "");
          clean = clean.replace(/<[^>]+>/g, "").trim().replace(/\s+/g, " ");
          if (clean && clean.length > 2 && !isPlaceholderTitle(clean)) {
            fallbackUserTitle = clean.length > 45 ? clean.slice(0, 45) + "…" : clean;
            break;
          }
        }
      } catch (e) {}
    }
  }

  return latestAiTitle || fallbackUserTitle || "Antigravity Sohbeti";
}

function extractSessionProject(lines) {
  let explicitProject = null;
  let detectedProject = null;

  // 1. Search for explicit project tag sentinel in bot responses or user requests
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    try {
      const step = JSON.parse(line);
      const content = step.content || "";
      const m = content.match(/<!--__AGY_PROJECT_TAG:\s*([^\n\r]+?)\s*__-->/) ||
                content.match(/<!--__AGY_PROJECT:\s*([^\n\r]+?)\s*__-->/) ||
                content.match(/<!--PROJECT_TAG:\s*([^\n\r]+?)\s*-->/) ||
                content.match(/<!--PROJECT:\s*([^\n\r]+?)\s*-->/);
      if (m && m[1]) {
        const p = m[1].trim().replace(/^\[|\]$/g, "");
        if (p && p.length > 1 && p.length < 50 && !isPlaceholderTitle(p)) {
          explicitProject = p;
          break;
        }
      }
    } catch (e) {}
  }

  if (explicitProject) return explicitProject;

  // 2. Scan for tool calls or path mentions pointing to a recognized project
  try {
    const homeDir = process.env.HOME || "/data/data/com.termux/files/home";
    const knownProjects = scanProjectsList(homeDir);
    const projectNames = (knownProjects || []).map(p => p.name).filter(Boolean);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line || !line.trim()) continue;
      for (const pName of projectNames) {
        if (line.includes(`${homeDir}/${pName}`) || line.includes(`/${pName}/`)) {
          detectedProject = pName;
          break;
        }
      }
      if (detectedProject) break;
    }
  } catch (e) {}

  return detectedProject || null;
}

function getVaultFiles(dirPath, baseRelative = "", maxDepth = 6) {
  let results = [];
  try {
    if (!fs.existsSync(dirPath)) return results;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const IGNORE_DIRS = new Set([".git", ".obsidian", ".stitch", ".cache", "node_modules", "dist", "build", ".gradle"]);
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name) || (entry.name.startsWith(".") && entry.name !== ".agents")) continue;
      const rel = baseRelative ? (baseRelative + "/" + entry.name) : entry.name;
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        results.push({ name: entry.name, path: rel, isDirectory: true });
        if (maxDepth > 0) {
          results = results.concat(getVaultFiles(full, rel, maxDepth - 1));
        }
      } else {
        const stats = fs.statSync(full);
        results.push({
          name: entry.name,
          path: rel,
          isDirectory: false,
          size: stats.size,
          updatedAt: stats.mtime.toISOString()
        });
      }
    }
  } catch (e) {}
  return results;
}

function scanInstalledSkills() {
  const skillsMap = new Map();
  const dirs = [
    "/data/data/com.termux/files/home/.gemini/antigravity-cli/skills",
    "/data/data/com.termux/files/home/.gemini/config/skills",
    "/data/data/com.termux/files/home/.agents/skills",
    "/data/data/com.termux/files/home/agy-vault/.agents/skills",
    "/data/data/com.termux/files/home/.gemini/antigravity-cli/builtin/skills",
    "/data/data/com.termux/files/home/agy-vault/.gemini/skills"
  ];

  dirs.forEach(dir => {
    try {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillMd = path.join(dir, entry.name, "SKILL.md");
        if (!fs.existsSync(skillMd)) continue;

        let description = "Skill for " + entry.name;
        let displayName = entry.name;
        try {
          const content = fs.readFileSync(skillMd, "utf-8");
          const descMatch = content.match(/description:\s*"([^"]+)"/) || content.match(/description:\s*([^\n]+)/);
          if (descMatch && descMatch[1]) {
            description = descMatch[1].trim().replace(/^["\x27]|["\x27]$/g, "");
          }
          const nameMatch = content.match(/name:\s*"([^"]+)"/) || content.match(/name:\s*([^\n]+)/);
          if (nameMatch && nameMatch[1]) {
            displayName = nameMatch[1].trim().replace(/^["\x27]|["\x27]$/g, "");
          }
        } catch (e) {}

        const skillKey = entry.name.toLowerCase();
        if (!skillsMap.has(skillKey)) {
          skillsMap.set(skillKey, {
            name: entry.name,
            displayName: displayName,
            command: "/" + entry.name,
            description: description,
            path: skillMd
          });
        }
      }
    } catch (e) {}
  });

  return Array.from(skillsMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function scanInstalledMcpServers() {
  const mcpList = [];
  const configFile = path.join(process.env.HOME || "/data/data/com.termux/files/home", ".gemini/config/mcp_config.json");
  const mcpSchemaDir = path.join(process.env.HOME || "/data/data/com.termux/files/home", ".gemini/antigravity-cli/mcp");

  const descriptions = {
    "groundtruth": { desc: "445+ kütüphane için çevrimdışı dökümantasyon ve kod denetimi", icon: "📚" },
    "design-token-bridge": { desc: "Tasarım token'larını Material 3 Jetpack Compose'a çevirici", icon: "🎨" },
    "reuse-before-generate": { desc: "Kod yazmadan önce GitHub/npm/PyPI açık kaynak alternatif arayıcı", icon: "♻️" },
    "nakkas": { desc: "Yapay zeka SVG vektör çizim ve animasyon motoru", icon: "🖋️" },
    "figma": { desc: "Figma REST API ve bileşen okuyucu", icon: "📐" },
    "gamedev": { desc: "Oyun motoru dökümantasyon ve karşılaştırma aracı", icon: "🎮" },
    "jcodemunch": { desc: "AST sembol arama ve mimari repo haritası", icon: "🔍" },
    "love2d": { desc: "Love2D Lua oyun geliştirme ve çalıştırma", icon: "🕹️" },
    "qwen": { desc: "Qwen AI modelleri ve multimodal medya köprüsü", icon: "🤖" },
    "stitch": { desc: "Google Stitch UI üretim ve tasarım sistemi", icon: "⚡" },
    "codevibe-antigravity": { desc: "CodeVibe mobil oturum köprüsü", icon: "📱" },
    "icons8mcp": { desc: "Icons8 görsel ve ikon arama sunucusu", icon: "🖼️" },
    "google-flow": { desc: "Medya ve tarayıcı otomasyon motoru", icon: "🌊" }
  };

  try {
    if (fs.existsSync(configFile)) {
      const cfg = JSON.parse(fs.readFileSync(configFile, "utf8"));
      if (cfg.mcpServers) {
        for (const [name, serverDef] of Object.entries(cfg.mcpServers)) {
          let tools = [];
          const serverDir = path.join(mcpSchemaDir, name);
          if (fs.existsSync(serverDir)) {
            try {
              tools = fs.readdirSync(serverDir)
                .filter(f => f.endsWith(".json"))
                .map(f => f.replace(".json", ""));
            } catch(e) {}
          }
          const info = descriptions[name] || { desc: "MCP Sunucusu", icon: "⚡" };
          mcpList.push({
            name,
            icon: info.icon,
            description: info.desc,
            command: `/mcp:${name}`,
            toolsCount: tools.length,
            tools: tools
          });
        }
      }
    }
  } catch(e) {}

  return mcpList.sort((a, b) => a.name.localeCompare(b.name));
}

// File System & Project Detection Helpers
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    case ".svg": return "image/svg+xml";
    case ".bmp": return "image/bmp";
    case ".ico": return "image/x-icon";
    case ".pdf": return "application/pdf";
    case ".json": return "application/json";
    case ".html":
    case ".htm": return "text/html; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".js":
    case ".mjs": return "application/javascript; charset=utf-8";
    case ".txt":
    case ".md":
    case ".kt":
    case ".java":
    case ".py":
    case ".ts":
    case ".jsx":
    case ".tsx":
    case ".sh":
    case ".bash":
    case ".c":
    case ".cpp":
    case ".h":
    case ".rs":
    case ".go":
    case ".xml":
    case ".yaml":
    case ".yml":
    case ".toml":
    case ".gradle":
    case ".properties":
    case ".env":
      return "text/plain; charset=utf-8";
    case ".mp4": return "video/mp4";
    case ".webm": return "video/webm";
    case ".mp3": return "audio/mpeg";
    case ".wav": return "audio/wav";
    case ".ogg": return "audio/ogg";
    case ".zip": return "application/zip";
    case ".tar":
    case ".gz": return "application/gzip";
    default: return "application/octet-stream";
  }
}

function detectProjectInfo(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) return null;
    const stat = fs.statSync(dirPath);
    if (!stat.isDirectory()) return null;

    let isProject = false;
    let type = "Klasör";
    let desc = "";
    let branch = null;

    const hasFile = (name) => fs.existsSync(path.join(dirPath, name));

    if (hasFile("build.gradle.kts") || hasFile("build.gradle")) {
      isProject = true;
      type = "Android";
      desc = "Android / Kotlin Projesi";
    } else if (hasFile("package.json")) {
      isProject = true;
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dirPath, "package.json"), "utf-8"));
        type = (pkg.dependencies && pkg.dependencies.next) ? "Next.js" :
               (pkg.dependencies && pkg.dependencies.react) ? "React" :
               (pkg.dependencies && pkg.dependencies.vue) ? "Vue" : "Node.js";
        desc = pkg.description || (pkg.name ? "Paket: " + pkg.name : "JavaScript / TypeScript Projesi");
      } catch (e) {
        type = "Node.js";
        desc = "Node.js / NPM Projesi";
      }
    } else if (hasFile("Cargo.toml")) {
      isProject = true;
      type = "Rust";
      desc = "Rust Cargo Projesi";
    } else if (hasFile("go.mod")) {
      isProject = true;
      type = "Go";
      desc = "Go Modül Projesi";
    } else if (hasFile("requirements.txt") || hasFile("pyproject.toml") || hasFile("Pipfile")) {
      isProject = true;
      type = "Python";
      desc = "Python Projesi";
    } else if (hasFile("pom.xml")) {
      isProject = true;
      type = "Java / Maven";
      desc = "Maven Java Projesi";
    } else if (hasFile("Makefile") || hasFile("CMakeLists.txt")) {
      isProject = true;
      type = "C/C++";
      desc = "C / C++ Derleme Projesi";
    } else {
      let hasHtml = false;
      try {
        hasHtml = fs.readdirSync(dirPath, { withFileTypes: true })
          .some(entry => entry.isFile() && /\.html?$/i.test(entry.name));
      } catch (e) {}
      if (hasHtml) {
        isProject = true;
        type = "Static Web";
        desc = "Statik HTML Web Projesi";
      }
    }

    if (!isProject && hasFile(".git")) {
      isProject = true;
      type = "Git";
      desc = "Sürüm Kontrol Projesi";
    }

    if (hasFile(".git")) {
      try {
        const headFile = path.join(dirPath, ".git", "HEAD");
        if (fs.existsSync(headFile)) {
          const headContent = fs.readFileSync(headFile, "utf-8").trim();
          if (headContent.startsWith("ref: refs/heads/")) {
            branch = headContent.replace("ref: refs/heads/", "");
          }
        }
      } catch (e) {}
    }

    return {
      isProject,
      type,
      description: desc,
      gitBranch: branch,
      name: path.basename(dirPath),
      path: dirPath,
      lastModified: stat.mtime.toISOString()
    };
  } catch (e) {
    return null;
  }
}

let cachedProjects = null;
let lastProjectsScanTs = 0;

function scanProjectsList(rootDir, force = false) {
  const now = Date.now();
  if (!force && cachedProjects && (now - lastProjectsScanTs < 60 * 1000)) {
    return cachedProjects;
  }
  const projects = [];
  try {
    const base = rootDir || process.env.HOME || "/data/data/com.termux/files/home";
    if (!fs.existsSync(base)) return projects;

    const entries = fs.readdirSync(base, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "build") continue;
      const full = path.join(base, entry.name);
      if (entry.isDirectory()) {
        const info = detectProjectInfo(full);
        if (info && info.isProject) {
          projects.push(info);
        } else {
          try {
            const subEntries = fs.readdirSync(full, { withFileTypes: true });
            for (const sub of subEntries) {
              if (sub.name.startsWith(".") || sub.name === "node_modules" || sub.name === "build") continue;
              if (sub.isDirectory()) {
                const subFull = path.join(full, sub.name);
                const subInfo = detectProjectInfo(subFull);
                if (subInfo && subInfo.isProject) {
                  projects.push(subInfo);
                }
              }
            }
          } catch (e) {}
        }
      }
    }
  } catch (e) {}
  cachedProjects = projects.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
  lastProjectsScanTs = now;
  return cachedProjects;
}

function resolveAnyFilePath(rawPath) {
  if (!rawPath) return null;
  let clean = rawPath.trim();
  if (clean.startsWith("file://")) clean = clean.replace("file://", "");
  if (clean.startsWith("~")) {
    const home = process.env.HOME || "/data/data/com.termux/files/home";
    clean = path.join(home, clean.substring(1));
  }
  if (!path.isAbsolute(clean)) {
    // Check uploads first, then vault, then home
    const inUploads = path.join(UPLOADS_DIR, clean.replace(/^uploads\//, ""));
    if (fs.existsSync(inUploads)) return inUploads;
    const inVault = path.join(VAULT_DIR, clean.replace(/^agy-vault\//, ""));
    if (fs.existsSync(inVault)) return inVault;
    clean = path.join(process.env.HOME || "/data/data/com.termux/files/home", clean);
  }
  return clean;
}

function isStaticWebDirectory(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory() && fs.readdirSync(dirPath, { withFileTypes: true })
      .some(entry => entry.isFile() && /\.html?$/i.test(entry.name));
  } catch (e) {
    return false;
  }
}

function isPreviewRootAllowed(realPath) {
  return PREVIEW_ALLOWED_ROOTS.some(allowed => realPath === allowed || realPath.startsWith(allowed + path.sep));
}

function selectPreviewEntry(root, requestedEntry) {
  if (requestedEntry) return requestedEntry;
  try {
    const htmlFiles = fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isFile() && /\.html?$/i.test(entry.name))
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b));
    return htmlFiles.find(name => name.toLowerCase() === "index.html") || htmlFiles[0] || null;
  } catch (e) {
    return null;
  }
}

function resolvePreviewFile(root, relativePath) {
  let requested;
  try {
    requested = decodeURIComponent(relativePath || "index.html");
  } catch (e) {
    return null;
  }
  if (requested.includes("\0")) return null;
  const candidate = path.resolve(root, "." + (requested.startsWith("/") ? requested : "/" + requested));
  if (candidate !== root && !candidate.startsWith(root + path.sep)) return null;
  let realCandidate;
  try {
    realCandidate = fs.realpathSync(candidate);
    const realRoot = fs.realpathSync(root);
    if (realCandidate !== realRoot && !realCandidate.startsWith(realRoot + path.sep)) return null;
    if (!fs.statSync(realCandidate).isFile()) return null;
  } catch (e) {
    return null;
  }
  return realCandidate;
}

function sendPreviewError(res, status, message) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: message }));
}

function isPreviewOrigin(origin) {
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" && Number(parsed.port || 80) === PREVIEW_PORT &&
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
  } catch (e) {
    return false;
  }
}

function handlePreviewRequest(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "application/json; charset=utf-8", "Allow": "GET, HEAD" });
    res.end(JSON.stringify({ error: "Method Not Allowed" }));
    return;
  }
  const pathname = new URL(req.url, "http://127.0.0.1").pathname;
  const match = pathname.match(/^\/preview\/([a-f0-9]{32})(?:\/(.*))?$/i);
  const root = match ? previewRoots.get(match[1]) : null;
  const filePath = root ? resolvePreviewFile(root, match[2] || "index.html") : null;
  if (!filePath) return sendPreviewError(res, 404, "Preview dosyası bulunamadı.");
  try {
    const stat = fs.statSync(filePath);
    res.writeHead(200, { "Content-Type": getMimeType(filePath), "Content-Length": stat.size, "Cache-Control": "no-cache" });
    if (req.method === "HEAD") res.end();
    else fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    sendPreviewError(res, 404, "Preview dosyası okunamadı.");
  }
}

// Usage Metrics (Real AGY CLI Quota & Structured Token Stats)
let cachedUsageMetrics = null;
let lastUsageCalculatedAt = 0;
let isFetchingUsage = false;
let usageFetchPromise = null;

try {
  if (fs.existsSync(USAGE_CACHE_FILE)) {
    const raw = fs.readFileSync(USAGE_CACHE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && (parsed.recent5h || (Array.isArray(parsed.groups) && parsed.groups.length > 0))) {
      cachedUsageMetrics = parsed;
      lastUsageCalculatedAt = Date.now();
    }
  }
} catch (e) {}
function calculateSessionContextTokens(session) {
  if (!session || !Array.isArray(session.messages)) return 0;
  let totalChars = 0;
  for (const m of session.messages) {
    totalChars += (m.content || "").length;
    if (Array.isArray(m.tools)) {
      for (const t of m.tools) {
        totalChars += (t.name || "").length + JSON.stringify(t.parameters || {}).length + (typeof t.output === "string" ? t.output.length : JSON.stringify(t.output || "").length);
      }
    }
  }
  return Math.max(1, Math.round(totalChars / 3.6));
}

function calculateTurnTokens(userPrompt, botMsg) {
  let turnChars = (userPrompt || "").length + (botMsg.content || "").length;
  if (Array.isArray(botMsg.tools)) {
    for (const t of botMsg.tools) {
      turnChars += (t.name || "").length + JSON.stringify(t.parameters || {}).length + (typeof t.output === "string" ? t.output.length : JSON.stringify(t.output || "").length);
    }
  }
  return Math.max(1, Math.round(turnChars / 3.6));
}

function parseUsageData(data, lastTurn = null) {
  let gemini5hRemaining = 100;
  let geminiWeeklyRemaining = 100;
  let gemini5hReset = null;
  let geminiWeeklyReset = null;
  let claudeWeeklyRemaining = 0;
  let claude5hRemaining = null;

  if (data && Array.isArray(data.groups)) {
    for (const group of data.groups) {
      const gName = (group.name || "").toLowerCase();
      if (gName.includes("gemini")) {
        for (const b of (group.buckets || [])) {
          if (b.window === "5h" || (b.id && b.id.includes("5h"))) {
            gemini5hRemaining = Math.max(0, Math.min(100, Math.round((b.remaining_fraction || 0) * 100)));
            gemini5hReset = b.reset_time;
          } else if (b.window === "weekly" || (b.id && b.id.includes("weekly"))) {
            geminiWeeklyRemaining = Math.max(0, Math.min(100, Math.round((b.remaining_fraction || 0) * 100)));
            geminiWeeklyReset = b.reset_time;
          }
        }
      } else if (gName.includes("claude") || gName.includes("gpt") || gName.includes("3p")) {
        for (const b of (group.buckets || [])) {
          if (b.window === "weekly" || (b.id && b.id.includes("weekly"))) {
            claudeWeeklyRemaining = Math.max(0, Math.min(100, Math.round((b.remaining_fraction || 0) * 100)));
          } else if (b.window === "5h" || (b.id && b.id.includes("5h"))) {
            claude5hRemaining = b.disabled ? "disabled" : Math.max(0, Math.min(100, Math.round((b.remaining_fraction || 0) * 100)));
          }
        }
      }
    }
  }

  let turnUsage = lastTurn;
  if (!turnUsage && currentSession && Array.isArray(currentSession.messages)) {
    const lastBot = [...currentSession.messages].reverse().find(m => m.role === "bot" && m.usage);
    if (lastBot) turnUsage = lastBot.usage;
  }

  return {
    recent5h: {
      totalTokens: turnUsage ? (turnUsage.total_tokens || 0) : 0,
      turnCount: 1,
      usedPercent: 100 - gemini5hRemaining,
      remainingPercent: gemini5hRemaining,
      windowHours: 5,
      resetTime: gemini5hReset
    },
    weekly: {
      totalTokens: turnUsage ? (turnUsage.total_tokens || 0) : 0,
      turnCount: 1,
      usedPercent: 100 - geminiWeeklyRemaining,
      remainingPercent: geminiWeeklyRemaining,
      inputTokens: turnUsage ? (turnUsage.input_tokens || 0) : 0,
      outputTokens: turnUsage ? (turnUsage.output_tokens || 0) : 0,
      thinkingTokens: turnUsage ? (turnUsage.thinking_tokens || 0) : 0,
      resetTime: geminiWeeklyReset
    },
    groups: data && Array.isArray(data.groups) ? data.groups : [],
    lastTurn: turnUsage,
    lastUpdated: new Date().toISOString()
  };
}

function formatUsageMarkdown(usageData) {
  if (!usageData || !Array.isArray(usageData.groups)) {
    return "📊 *Model kota bilgisi alınamadı.*";
  }

  let md = "### 📊 Model Kotası & Kalan Limitler\n\n";
  md += "| Model Grubu | Limit Türü | Kalan | Yenilenme Zamanı |\n";
  md += "| :--- | :--- | :--- | :--- |\n";

  for (const group of usageData.groups) {
    const gName = group.name || "Modeller";
    for (const b of (group.buckets || [])) {
      const bName = b.name || b.window || "Limit";
      let remText = "%" + Math.round((b.remaining_fraction || 0) * 100);
      if (b.disabled) remText = "Devre Dışı";
      else if (b.remaining_fraction === 0) remText = "❌ %0 (Doldu)";
      else if (b.remaining_fraction > 0.5) remText = "🟢 " + remText;
      else if (b.remaining_fraction > 0.2) remText = "🟡 " + remText;
      else remText = "🔴 " + remText;

      let resetText = "-";
      if (b.reset_time) {
        try {
          const d = new Date(b.reset_time);
          resetText = d.toLocaleString("tr-TR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
        } catch (e) {
          resetText = b.reset_time;
        }
      }

      md += `| **${gName}** | ${bName} | ${remText} | ${resetText} |\n`;
    }
  }

  md += "\n> 💡 *Her model grubu içinde modeller ortak 5 saatlik ve haftalık havuzu paylaşır.*";
  return md;
}

function formatModelsMarkdown(currentModelId = null) {
  let md = "### 🤖 Kullanılabilir Antigravity Modelleri\n\n";
  md += "| Model ID | Model Adı | Açıklama |\n";
  md += "| :--- | :--- | :--- |\n";
  for (const m of cachedModels) {
    const isCurrent = currentModelId ? (m.id === currentModelId) : false;
    const indicator = isCurrent ? "⭐ **(Aktif)** " : "";
    md += `| \`${m.id}\` | ${indicator}${m.name} | ${m.description} |\n`;
  }
  md += "\n> 💡 *Model değiştirmek için üst bardaki model adına dokunabilir veya `/model <model-id>` parametresi verebilirsiniz.*";
  return md;
}

function formatHelpMarkdown(helpData) {
  if (!helpData || !Array.isArray(helpData.commands)) {
    return "💡 *Kullanılabilir komutlar listelenemedi.*";
  }
  let md = "### ⚡ Kullanılabilir Slash Komutları\n\n";
  md += "| Komut | Açıklama |\n";
  md += "| :--- | :--- |\n";
  for (const cmd of helpData.commands) {
    const aliasStr = cmd.aliases && cmd.aliases.length > 0 ? ` (veya /${cmd.aliases.join(', /')})` : '';
    md += `| \`/${cmd.name}\`${aliasStr} | ${cmd.description || ''} |\n`;
  }
  return md;
}

async function fetchRealAgyUsage(force = false) {
  const now = Date.now();
  if (!force && cachedUsageMetrics && (now - lastUsageCalculatedAt < 60 * 1000)) {
    return cachedUsageMetrics;
  }

  if (usageFetchPromise) {
    return usageFetchPromise;
  }

  usageFetchPromise = new Promise((resolve) => {
    let resolved = false;
    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      usageFetchPromise = null;
      resolve(result);
    };

    const env = {
      ...process.env,
      CODEVIBE_ALLOW_FILE_KEYCHAIN: "1",
      AGY_AUTO_UPDATE: "0",
      HOME: "/data/data/com.termux/files/home",
      PREFIX: "/data/data/com.termux/files/usr",
      PATH: process.env.PATH || "/data/data/com.termux/files/usr/bin",
      TERM: "xterm-256color"
    };

    const agyBin = fs.existsSync("/data/data/com.termux/files/usr/bin/agy") ? "/data/data/com.termux/files/usr/bin/agy" : "agy";
    const child = spawn(agyBin, ["--dangerously-skip-permissions", "--output-format", "stream-json", "-p", "/usage"], {
      cwd: process.env.HOME || "/data/data/com.termux/files/home",
      env
    });
    try { child.stdin.end(); } catch (e) {}

    let stdout = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch (e) {}
      finish(cachedUsageMetrics || parseUsageData(null));
    }, 45000);

    child.stdout.on("data", d => {
      stdout += d.toString();
      // Eager parsing as soon as data arrives
      const lines = stdout.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
        try {
          const json = JSON.parse(trimmed);
          const data = (json.command && json.command.data) || (json.result && json.result.command && json.result.command.data) || null;
          if (data && Array.isArray(data.groups) && data.groups.length > 0) {
            cachedUsageMetrics = parseUsageData(data);
            lastUsageCalculatedAt = Date.now();
            try { fs.writeFileSync(USAGE_CACHE_FILE, JSON.stringify(cachedUsageMetrics, null, 2)); } catch(e) {}
            broadcastSSE("usage_update", { usage: cachedUsageMetrics });
            clearTimeout(timer);
            finish(cachedUsageMetrics);
            return;
          }
        } catch (e) {}
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        const lines = stdout.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
          try {
            const json = JSON.parse(trimmed);
            const data = (json.command && json.command.data) || (json.result && json.result.command && json.result.command.data) || null;
            if (data && Array.isArray(data.groups) && data.groups.length > 0) {
              cachedUsageMetrics = parseUsageData(data);
              lastUsageCalculatedAt = Date.now();
              try { fs.writeFileSync(USAGE_CACHE_FILE, JSON.stringify(cachedUsageMetrics, null, 2)); } catch(e) {}
              broadcastSSE("usage_update", { usage: cachedUsageMetrics });
              finish(cachedUsageMetrics);
              return;
            }
          } catch (e) {}
        }
      } catch (e) {}
      finish(cachedUsageMetrics || parseUsageData(null));
    });

    child.on("error", () => {
      clearTimeout(timer);
      finish(cachedUsageMetrics || parseUsageData(null));
    });
  });

  return usageFetchPromise;
}

// Initial fetch on boot & periodic background refresh every 5 mins (300,000 ms)
fetchRealAgyUsage().catch(() => {});
setInterval(() => {
  fetchRealAgyUsage(true).catch(() => {});
}, 5 * 60 * 1000);

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  const pathname = parsedUrl.pathname;
  if (pathname.startsWith("/api") && isPreviewOrigin(req.headers.origin)) {
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Preview origin API erişimine izin verilmez." }));
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === "/api/terminal/tasks" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ status: "ok", tasks: getManagedTasks() }));
    return;
  }

  if (pathname === "/api/terminal/plugins" && req.method === "GET") {
    const actions = getActions();
    const grouped = new Map();
    for (const { id, label } of Object.values(actions)) {
      const service = id === "vault-sync" ? "vault" : id.replace(/-(start|stop)$/, "");
      if (!grouped.has(service)) grouped.set(service, { id: service, name: service, enabled: true, actions: [] });
      grouped.get(service).actions.push({ id, label });
    }
    const plugins = [...grouped.values()];
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ status: "ok", plugins }));
    return;
  }

  if (pathname === "/api/terminal/plugins/reload" && req.method === "POST") {
    try {
      const manifest = manifestForReload();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ status: "ok", reloadedAt: new Date().toISOString(), manifest }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ status: "error", error: err.message }));
    }
    return;
  }

  if (pathname === "/api/terminal/schedules" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ status: "ok", schedules: readSchedules(), schema: { id: "string", actionId: "known manifest action id", triggerAt: "future Unix timestamp in milliseconds", label: "string?", enabled: "boolean?" } }));
    return;
  }

  if (pathname === "/api/terminal/schedules" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 8192) req.destroy(); });
    req.on("end", () => {
      let input;
      try { input = JSON.parse(body || "{}"); } catch (err) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Geçersiz JSON" })); return; }
      const actionId = input && input.actionId;
      const triggerAt = input && input.triggerAt;
      const id = input && input.id;
      if (typeof id !== "string" || !/^[A-Za-z0-9._:-]{1,96}$/.test(id) || typeof actionId !== "string" || !getActions()[actionId]) {
        res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "id ve manifestteki bilinen actionId zorunludur." })); return;
      }
      if (!Number.isFinite(triggerAt) || triggerAt <= Date.now()) {
        res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "triggerAt gelecekteki Unix timestamp (ms) olmalıdır." })); return;
      }
      const schedules = readSchedules().filter(item => item.id !== id);
      const schedule = { id, actionId, triggerAt, ...(typeof input.label === "string" ? { label: input.label.slice(0, 200) } : {}), ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : { enabled: true }) };
      schedules.push(schedule);
      writeSchedules(schedules);
      res.writeHead(201, { "Content-Type": "application/json" }); res.end(JSON.stringify({ status: "ok", schedule }));
    });
    return;
  }

  if (pathname.startsWith("/api/terminal/schedules/") && req.method === "DELETE") {
    const id = decodeURIComponent(pathname.slice("/api/terminal/schedules/".length));
    const schedules = readSchedules();
    const next = schedules.filter(item => item.id !== id);
    if (next.length === schedules.length) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Schedule bulunamadı." })); return; }
    writeSchedules(next);
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ status: "ok", id }));
    return;
  }

  if (pathname === "/api/actions" && req.method === "GET") {
    const actions = getActions();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ status: "ok", actions: Object.values(actions).map(({ id, label, compactLabel, category, icon, order }) => ({ id, label, compactLabel, category, icon, order })) }));
    return;
  }

  if (pathname === "/api/actions/run" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 8192) req.destroy(); });
    req.on("end", () => {
      let input;
      try { input = JSON.parse(body || "{}"); } catch (e) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Geçersiz JSON" })); return; }
      const actions = getActions();
      const action = typeof input.id === "string" ? actions[input.id] : null;
      if (!action) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Bilinmeyen action" })); return; }
      if (runningActions.size > 0) { res.writeHead(409, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Başka bir action çalışıyor" })); return; }
      const actionId = crypto.randomUUID();
      const child = spawn(action.executable, action.args, { cwd: "/data/data/com.termux/files/home", env: { ...process.env, HOME: "/data/data/com.termux/files/home" }, shell: false });
      runningActions.set(actionId, child);
      const emitLines = (stream, channel) => stream.on("data", chunk => String(chunk).split(/\r?\n/).filter(Boolean).forEach(line => broadcastSSE("action_output", { actionId, id: action.id, stream: channel, line })));
      emitLines(child.stdout, "stdout"); emitLines(child.stderr, "stderr");
      const timeout = setTimeout(() => { if (runningActions.has(actionId)) child.kill("SIGTERM"); }, ACTION_TIMEOUT_MS);
      broadcastSSE("action_started", { actionId, id: action.id, pid: child.pid });
      child.on("error", err => broadcastSSE("action_output", { actionId, id: action.id, stream: "stderr", line: err.message }));
      child.on("close", exitCode => { clearTimeout(timeout); runningActions.delete(actionId); broadcastSSE("action_finished", { actionId, id: action.id, exitCode }); });
      res.writeHead(202, { "Content-Type": "application/json" }); res.end(JSON.stringify({ status: "started", actionId, id: action.id, pid: child.pid }));
    });
    return;
  }

  if (pathname === "/api/preview/open" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 64 * 1024) req.destroy();
    });
    req.on("end", () => {
      try {
        const data = JSON.parse(body || "{}");
        const entryPath = typeof data.entryPath === "string" ? data.entryPath.trim() : "";
        const root = entryPath ? resolveAnyFilePath(entryPath) : null;
        if (!root || !fs.existsSync(root)) return sendPreviewError(res, 400, "entryPath geçerli değil.");
        const realEntry = fs.realpathSync(root);
        if (!isPreviewRootAllowed(realEntry)) return sendPreviewError(res, 403, "Preview yolu izinli köklerin dışında.");
        const stat = fs.statSync(realEntry);
        const projectRoot = stat.isDirectory() ? realEntry : path.dirname(realEntry);
        if (!isStaticWebDirectory(projectRoot)) return sendPreviewError(res, 400, "Static Web projesi bulunamadı.");
        const previewId = crypto.randomBytes(16).toString("hex");
        if (previewRoots.size >= MAX_PREVIEW_SESSIONS) {
          previewRoots.delete(previewRoots.keys().next().value);
        }
        previewRoots.set(previewId, projectRoot);
        const entryName = stat.isDirectory() ? selectPreviewEntry(projectRoot) : path.basename(realEntry);
        if (!entryName) return sendPreviewError(res, 400, "Preview giriş HTML dosyası bulunamadı.");
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ status: "ok", previewId, url: "http://127.0.0.1:" + PREVIEW_PORT + "/preview/" + previewId + "/" + encodeURIComponent(entryName) }));
      } catch (e) {
        sendPreviewError(res, 400, "Geçersiz preview isteği.");
      }
    });
    return;
  }

  // SSE Stream
  if (pathname === "/api/events" && req.method === "GET") {
    if (req.socket) {
      try {
        req.socket.setTimeout(0);
        req.socket.setKeepAlive(true, 5000);
        req.socket.setNoDelay(true);
      } catch (e) {}
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });
    if (typeof res.flushHeaders === "function") {
      try { res.flushHeaders(); } catch (e) {}
    }

    const clientId = Date.now() + "_" + Math.random().toString(36).substr(2, 5);
    const client = { id: clientId, res };
    sseClients.push(client);
    try {
      require("fs").appendFileSync("/data/data/com.termux/files/home/agy_sse.log",
        `[${new Date().toISOString()}] CONNECT SSE id=${clientId} total=${sseClients.length}\n`);
    } catch (e) {}

    res.write("event: handshake\ndata: " + JSON.stringify({
      status: "connected",
      isGenerating: currentSession.isGenerating,
      sessionId: currentSession.id,
      conversationId: currentSession.conversationId
    }) + "\n\n");

    req.on("close", () => {
      sseClients = sseClients.filter(c => c.id !== clientId);
      try {
        require("fs").appendFileSync("/data/data/com.termux/files/home/agy_sse.log",
          `[${new Date().toISOString()}] CLOSE SSE id=${clientId} total=${sseClients.length}\n`);
      } catch (e) {}
    });
    return;
  }

  // Models List
  if (pathname === "/api/models" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      models: cachedModels,
      efforts: [
        { id: "default", name: "Varsayılan", description: "Modelin kendi varsayılan ayarı" },
        { id: "low", name: "Düşük (Hızlı)", description: "Minimum düşünme gecikmesi" },
        { id: "medium", name: "Orta (Dengeli)", description: "Standart düşünme derinliği" },
        { id: "high", name: "Yüksek (Derin)", description: "Detaylı adım adım akıl yürütme" }
      ],
      modes: [
        { id: "default", name: "Standart Mod" },
        { id: "plan", name: "Planlama Modu (--mode plan)" },
        { id: "accept-edits", name: "Otomatik Kabul Modu (--mode accept-edits)" }
      ]
    }));
    return;
  }

  // Auth Status
  if (pathname === "/api/auth/status" && req.method === "GET") {
    let isAuthed = false;
    let authMethod = "none";
    try {
      if (fs.existsSync(TOKEN_FILE_PATH) && fs.statSync(TOKEN_FILE_PATH).size > 10) {
        checkAndRefreshToken().catch(() => {});
        isAuthed = true;
        authMethod = "oauth";
      }
    } catch (e) {}

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      isAuthenticated: isAuthed,
      authMethod: authMethod
    }));
    return;
  }

  // Start OAuth Login Flow (Generates PKCE URL for App)
  if ((pathname === "/api/auth/login/start" || pathname === "/api/auth/login") && req.method === "POST") {
    try {
      const verifier = crypto.randomBytes(32).toString("base64url");
      const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
      const state = crypto.randomBytes(16).toString("base64url");
      pendingPkce = { verifier, state, timestamp: Date.now() };

      const params = new URLSearchParams({
        access_type: "offline",
        client_id: OAUTH_CLIENT_ID,
        code_challenge: challenge,
        code_challenge_method: "S256",
        prompt: "consent",
        redirect_uri: "https://antigravity.google/oauth-callback",
        response_type: "code",
        scope: "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs https://www.googleapis.com/auth/aicode openid",
        state: state
      });

      const authUrl = `https://accounts.google.com/o/oauth2/auth?${params.toString()}`;

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        authUrl: authUrl
      }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "error", error: e.message }));
    }
    return;
  }

  // Submit OAuth Authorization Code
  if ((pathname === "/api/auth/login/code" || pathname === "/api/auth/code") && req.method === "POST") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", async () => {
      try {
        const json = JSON.parse(body || "{}");
        let rawCode = (json.code || "").trim();

        if (rawCode.includes("code=")) {
          const match = rawCode.match(/code=([^&]+)/);
          if (match) rawCode = decodeURIComponent(match[1]);
        }

        if (!rawCode) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "error", error: "Yetkilendirme kodu boş olamaz." }));
          return;
        }

        // Pipe to active child process waiting for stdin if present
        if (authWaitingChildProcess && !authWaitingChildProcess.killed && authWaitingChildProcess.stdin && authWaitingChildProcess.stdin.writable) {
          try {
            authWaitingChildProcess.stdin.write(rawCode + "\n");
            console.log("[AUTH] Wrote authorization code to waiting agy process stdin");
          } catch (pe) {
            console.warn("[AUTH] Failed writing to child stdin:", pe.message);
          }
        }

        // Exchange code directly with Google token endpoint
        let exchangeSuccess = false;
        let exchangeError = null;

        if (pendingPkce && pendingPkce.verifier) {
          const postData = new URLSearchParams({
            client_id: OAUTH_CLIENT_ID,
            client_secret: OAUTH_CLIENT_SECRET,
            code: rawCode,
            code_verifier: pendingPkce.verifier,
            redirect_uri: "https://antigravity.google/oauth-callback",
            grant_type: "authorization_code"
          }).toString();

          const result = await new Promise((resolve) => {
            const tokenReq = https.request("https://oauth2.googleapis.com/token", {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "Content-Length": Buffer.byteLength(postData)
              },
              timeout: 15000
            }, (tokenRes) => {
              let resBody = "";
              tokenRes.on("data", c => resBody += c);
              tokenRes.on("end", () => {
                try {
                  resolve({ status: tokenRes.statusCode, body: JSON.parse(resBody || "{}") });
                } catch (e) {
                  resolve({ status: tokenRes.statusCode, error: e.message });
                }
              });
            });
            tokenReq.on("error", err => resolve({ error: err.message }));
            tokenReq.on("timeout", () => { tokenReq.destroy(); resolve({ error: "timeout" }); });
            tokenReq.write(postData);
            tokenReq.end();
          });

          if (result.status === 200 && result.body && result.body.access_token) {
            const expiresInSec = result.body.expires_in || 3600;
            const newExpiry = new Date(Date.now() + expiresInSec * 1000).toISOString();

            let tokenObj = { auth_method: "consumer", token: {} };
            try {
              if (fs.existsSync(TOKEN_FILE_PATH)) {
                tokenObj = JSON.parse(fs.readFileSync(TOKEN_FILE_PATH, "utf8"));
              }
            } catch (e) {}

            tokenObj.auth_method = "consumer";
            tokenObj.token = {
              access_token: result.body.access_token,
              token_type: result.body.token_type || "Bearer",
              refresh_token: result.body.refresh_token || (tokenObj.token && tokenObj.token.refresh_token) || "",
              expiry: newExpiry
            };

            const tokenDir = path.dirname(TOKEN_FILE_PATH);
            if (!fs.existsSync(tokenDir)) fs.mkdirSync(tokenDir, { recursive: true });
            fs.writeFileSync(TOKEN_FILE_PATH, JSON.stringify(tokenObj, null, 2), { mode: 0o600 });

            try {
              fs.appendFileSync("/data/data/com.termux/files/home/agy_diag.log",
                `[${new Date().toISOString()}] [AUTH] Exchanged authorization code successfully, new expiry=${newExpiry}\n`);
            } catch (e) {}

            exchangeSuccess = true;
            pendingPkce = null;
          } else {
            exchangeError = (result.body && (result.body.error_description || result.body.error)) || result.error || "Token exchange failed";
          }
        }

        if (exchangeSuccess) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", message: "Giriş başarıyla tamamlandı!" }));
          broadcastSSE("auth_success", { status: "ok" });
        } else if (authWaitingChildProcess) {
          setTimeout(() => {
            const isNowAuthed = fs.existsSync(TOKEN_FILE_PATH) && fs.statSync(TOKEN_FILE_PATH).size > 10;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              status: isNowAuthed ? "ok" : "pending",
              message: isNowAuthed ? "Giriş tamamlandı." : "Kod agy işlemine iletildi."
            }));
          }, 1500);
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            status: "error",
            error: exchangeError || "Kod doğrulanamadı. Tarayıcıda yeni giriş başlatıp kodu tekrar girin."
          }));
        }
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", error: err.message }));
      }
    });
    return;
  }

  // Skills List
  if (pathname === "/api/skills" && req.method === "GET") {
    const skills = scanInstalledSkills();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", count: skills.length, skills }));
    return;
  }

  // MCP Servers & Tools List
  if (pathname === "/api/mcps" && req.method === "GET") {
    const mcps = scanInstalledMcpServers();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", count: mcps.length, mcps }));
    return;
  }

  // Model Quota & Usage (Real non-blocking AGY metrics)
  if (pathname === "/api/usage" && req.method === "GET") {
    const force = parsedUrl.searchParams.get("force") === "true";
    let usage = cachedUsageMetrics;
    if (!usage || force || (Date.now() - lastUsageCalculatedAt > 60 * 1000)) {
      usage = await fetchRealAgyUsage(force);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", usage: usage || cachedUsageMetrics || parseUsageData(null) }));
    return;
  }

  // File Upload (with path traversal protection)
  if (pathname === "/api/upload" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 50e6) req.destroy();
    });

    req.on("end", () => {
      try {
        const { name, base64, type } = JSON.parse(body || "{}");
        if (!name || !base64) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "name ve base64 gereklidir." }));
          return;
        }

        const safeName = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, "_");
        const fileName = Date.now() + "_" + safeName;
        const filePath = path.join(UPLOADS_DIR, fileName);

        const buffer = Buffer.from(base64, "base64");
        fs.writeFileSync(filePath, buffer);

        const workspaceCopy = path.join(process.env.HOME || "/data/data/com.termux/files/home", safeName);
        try { fs.writeFileSync(workspaceCopy, buffer); } catch(e) {}

        const relPath = "uploads/" + fileName;
        const imgMeta = getImageMetadataAndOptimize(filePath);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "ok",
          fileName: safeName,
          path: filePath,
          relPath: relPath,
          workspacePath: workspaceCopy,
          size: buffer.length,
          type: type || "file",
          metadata: imgMeta ? imgMeta.metaStr : null,
          width: imgMeta ? imgMeta.width : null,
          height: imgMeta ? imgMeta.height : null
        }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Serve uploaded files (Path Traversal Protected)
  if (pathname.startsWith("/uploads/")) {
    const safeRel = path.normalize(pathname.replace("/uploads/", "")).replace(/^(\.\.[\/\\])+/, "");
    const file = path.join(UPLOADS_DIR, safeRel);
    if (file.startsWith(UPLOADS_DIR) && fs.existsSync(file)) {
      const ext = path.extname(file).toLowerCase();
      const contentType = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "application/octet-stream";
      res.writeHead(200, { "Content-Type": contentType });
      fs.createReadStream(file).pipe(res);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("File Not Found");
    return;
  }

  // Stream raw binary / image / document from anywhere in Termux / SDCard (with CORS & Inline headers)
  if (pathname === "/api/files/raw" && req.method === "GET") {
    const rawPath = parsedUrl.searchParams.get("path");
    if (!rawPath) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "path parametresi zorunludur." }));
      return;
    }

    const resolved = resolveAnyFilePath(rawPath);
    if (!resolved || !fs.existsSync(resolved)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Dosya bulunamadı: " + rawPath }));
      return;
    }

    try {
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Belirtilen yol bir dizindir." }));
        return;
      }

      const mime = getMimeType(resolved);
      res.writeHead(200, {
        "Content-Type": mime,
        "Content-Length": stat.size,
        "Content-Disposition": "inline; filename=\"" + encodeURIComponent(path.basename(resolved)) + "\"",
        "Cache-Control": "public, max-age=86400"
      });
      fs.createReadStream(resolved).pipe(res);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // List Termux File System & Detected Projects
  if (pathname === "/api/fs/list" && req.method === "GET") {
    const homeDir = process.env.HOME || "/data/data/com.termux/files/home";
    const reqDir = parsedUrl.searchParams.get("dir");
    let targetDir = reqDir ? resolveAnyFilePath(reqDir) : homeDir;

    if (!targetDir || !fs.existsSync(targetDir)) {
      targetDir = homeDir;
    }

    try {
      const stat = fs.statSync(targetDir);
      if (!stat.isDirectory()) {
        targetDir = path.dirname(targetDir);
      }

      const entries = fs.readdirSync(targetDir, { withFileTypes: true });
      const items = [];
      const IGNORE_SET = new Set([
        ".git", ".gitignore", ".gitmodules", ".gitattributes",
        "node_modules", "build", "dist", ".gradle", ".idea", ".vscode",
        "__pycache__", ".pytest_cache", ".cache", ".npm",
        ".tmp", "tmp", "temp", ".temp", ".DS_Store", "thumbs.db",
        ".bash_history", ".lesshst", ".system_generated",
        "agy_stdout.log", "agy_diag.log", "agy_sse.log", "models_cache.json"
      ]);

      for (const entry of entries) {
        if (IGNORE_SET.has(entry.name) || entry.name.endsWith(".tmp") || entry.name.endsWith("~")) {
          continue;
        }

        const fullPath = path.join(targetDir, entry.name);
        try {
          const s = fs.statSync(fullPath);
          const isDir = s.isDirectory();
          let isProj = false;
          let projType = null;
          let count = null;

          if (isDir) {
            const pInfo = detectProjectInfo(fullPath);
            if (pInfo && pInfo.isProject) {
              isProj = true;
              projType = pInfo.type;
            }
            try {
              const children = fs.readdirSync(fullPath);
              count = children.filter(c => !IGNORE_SET.has(c)).length;
            } catch (e) {}
          }

          items.push({
            name: entry.name,
            path: fullPath,
            isDirectory: isDir,
            size: isDir ? null : s.size,
            updatedAt: s.mtime.toISOString(),
            extension: isDir ? null : path.extname(entry.name).toLowerCase(),
            isProject: isProj,
            projectType: projType,
            itemCount: count
          });
        } catch (err) {}
      }

      // Sort: Folders first, then alphabetical
      items.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      });

      const parentDir = (targetDir === "/" || targetDir === homeDir) ? null : path.dirname(targetDir);
      const projects = scanProjectsList(homeDir);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        currentDir: targetDir,
        parentDir: parentDir,
        homeDir: homeDir,
        items: items,
        projects: projects
      }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Health check endpoint
  if ((pathname === "/api/health" || pathname === "/health") && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({
      status: "ok",
      uptime: Math.floor(process.uptime()),
      pid: process.pid,
      version: "2.0",
      time: new Date().toISOString()
    }));
    return;
  }

  // Graceful shutdown endpoint
  if (pathname === "/api/system/shutdown" && req.method === "POST") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ status: "ok", message: "Sunucu kapatılıyor..." }));
    setTimeout(() => {
      process.exit(0);
    }, 500);
    return;
  }

  // Scan & Return Detected Termux Projects
  if (pathname === "/api/fs/projects" && req.method === "GET") {
    try {
      const homeDir = process.env.HOME || "/data/data/com.termux/files/home";
      const projects = scanProjectsList(homeDir);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", count: projects.length, projects }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Read Text/Code File Content for In-App Viewer
  if (pathname === "/api/fs/content" && req.method === "GET") {
    const rawPath = parsedUrl.searchParams.get("path");
    if (!rawPath) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "path parametresi zorunludur." }));
      return;
    }

    const resolved = resolveAnyFilePath(rawPath);
    if (!resolved || !fs.existsSync(resolved)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Dosya bulunamadı: " + rawPath }));
      return;
    }

    try {
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Belirtilen yol bir dizindir." }));
        return;
      }

      if (stat.size > 10 * 1024 * 1024) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Dosya boyutu çok büyük (10MB sınırı aşıldı)." }));
        return;
      }

      const buffer = fs.readFileSync(resolved);
      const isBinary = buffer.includes(0);
      const ext = path.extname(resolved).toLowerCase();

      if (isBinary) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "ok",
          path: resolved,
          size: stat.size,
          lineCount: 0,
          isBinary: true,
          extension: ext
        }));
        return;
      }

      const content = buffer.toString("utf-8");
      const lines = content.split("\n").length;

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        path: resolved,
        content: content,
        size: stat.size,
        lineCount: lines,
        isBinary: false,
        extension: ext
      }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Download Raw Binary / Text File Stream
  if ((pathname === "/api/fs/raw" || pathname === "/api/fs/download") && (req.method === "GET" || req.method === "HEAD")) {
    const rawPath = parsedUrl.searchParams.get("path");
    if (!rawPath) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "path parametresi zorunludur." }));
      return;
    }

    const resolved = resolveAnyFilePath(rawPath);
    if (!resolved || !fs.existsSync(resolved)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Dosya bulunamadı: " + rawPath }));
      return;
    }

    try {
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Belirtilen yol bir dizindir." }));
        return;
      }

      const fileName = path.basename(resolved);
      const mime = getMimeType(resolved) || "application/octet-stream";

      res.writeHead(200, {
        "Content-Type": mime,
        "Content-Length": stat.size,
        "Content-Disposition": `attachment; filename="${encodeURIComponent(fileName)}"`
      });

      const stream = fs.createReadStream(resolved);
      stream.pipe(res);
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    }
    return;
  }

  // Save / Edit File Content
  if (pathname === "/api/fs/save" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try {
        const { path: rawPath, content } = JSON.parse(body || "{}");
        if (!rawPath) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "path parametresi zorunludur." }));
          return;
        }

        const resolved = resolveAnyFilePath(rawPath);
        const parentDir = path.dirname(resolved);
        if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });

        fs.writeFileSync(resolved, content || "", "utf-8");
        const stat = fs.statSync(resolved);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "ok",
          message: "Dosya başarıyla kaydedildi.",
          path: resolved,
          size: stat.size
        }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // List Conversations (Direct from Brain Cache - Non-blocking)
  if (pathname === "/api/conversations" && req.method === "GET") {
    const list = await getBrainConversations();
    const activeConvId = currentSession.conversationId || currentSession.id;
    const includeSubagents = (req.url && (req.url.includes("includeSubagents=true") || req.url.includes("all=true")));
    const filteredList = includeSubagents ? list : list.filter(c => !c.isSubagent);
    const enrichedList = filteredList.map(c => ({
      ...c,
      isGenerating: Boolean(currentSession.isGenerating && (activeConvId === c.id))
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      currentSessionId: activeConvId,
      activeGeneratingId: currentSession.isGenerating ? activeConvId : null,
      isGenerating: currentSession.isGenerating,
      conversations: enrichedList
    }));
    return;
  }

  // Export All Conversations (Full JSON / Markdown archive)
  if (pathname === "/api/export/all" && req.method === "GET") {
    try {
      const convList = await getBrainConversations();
      const allSessions = [];
      for (const meta of convList) {
        const full = await loadBrainConversation(meta.id);
        if (full) allSessions.push(full);
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Disposition": "attachment; filename=\"antigravity_all_sessions_" + Date.now() + ".json\""
      });
      res.end(JSON.stringify({
        exportedAt: new Date().toISOString(),
        totalSessions: allSessions.length,
        sessions: allSessions
      }, null, 2));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Get Subagents for a Conversation
  if (pathname.startsWith("/api/conversations/") && pathname.endsWith("/subagents") && req.method === "GET") {
    const convId = pathname.replace("/api/conversations/", "").replace("/subagents", "").trim();
    const subagents = await getSubagentsForConversation(convId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", conversationId: convId, subagents }));
    return;
  }

  // Get Tasks for a Conversation
  if (pathname.startsWith("/api/conversations/") && pathname.endsWith("/tasks") && req.method === "GET") {
    const convId = pathname.replace("/api/conversations/", "").replace("/tasks", "").trim();
    const tasks = await getTasksForConversation(convId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", conversationId: convId, tasks }));
    return;
  }

  // Get Specific Task Log
  if (pathname.startsWith("/api/conversations/") && pathname.includes("/tasks/") && pathname.endsWith("/log") && req.method === "GET") {
    const parts = pathname.replace("/api/conversations/", "").split("/tasks/");
    const convId = parts[0];
    const taskId = (parts[1] || "").replace("/log", "").trim();
    const logFile = path.join(BRAIN_DIR, convId, ".system_generated", "tasks", `${taskId}.log`);
    if (fs.existsSync(logFile)) {
      try {
        const content = await fs.promises.readFile(logFile, "utf-8");
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(content);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Task log not found" }));
    }
    return;
  }

  // Load Specific Conversation
  if (pathname.startsWith("/api/conversations/") && req.method === "GET") {
    const convId = pathname.replace("/api/conversations/", "").trim();
    const brainSession = await loadBrainConversation(convId);
    if (brainSession) {
      const isGeneratingThis = Boolean(currentSession.isGenerating && (currentSession.conversationId === convId || currentSession.id === convId));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        session: brainSession,
        isGenerating: isGeneratingThis
      }));
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Sohbet kaydı bulunamadı." }));
    }
    return;
  }

  // Delete Conversation
  if (pathname.startsWith("/api/conversations/") && req.method === "DELETE") {
    const convId = pathname.replace("/api/conversations/", "").trim();
    try {
      const convFolder = path.join(BRAIN_DIR, convId);
      if (fs.existsSync(convFolder)) {
        await fs.promises.rm(convFolder, { recursive: true, force: true });
      }
      brainConversationsCache.delete(convId);

      const list = await getBrainConversations(true);
      if (currentSession.conversationId === convId || currentSession.id === convId) {
        currentSession = { id: null, conversationId: null, title: "Yeni Sohbet", messages: [], isGenerating: false };
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", conversations: list }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // AGY Vault File Tree
  if (pathname === "/api/vault" && req.method === "GET") {
    const files = getVaultFiles(VAULT_DIR);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", vaultDir: VAULT_DIR, files }));
    return;
  }

  // AGY Vault Content
  if (pathname === "/api/vault/content" && req.method === "GET") {
    const relPath = parsedUrl.searchParams.get("path");
    if (!relPath) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "path parametresi zorunludur." }));
      return;
    }
    const fullPath = path.join(VAULT_DIR, relPath);
    if (!fullPath.startsWith(VAULT_DIR) || !fs.existsSync(fullPath)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Dosya bulunamadı." }));
      return;
    }

    try {
      const content = fs.readFileSync(fullPath, "utf-8");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", path: relPath, content }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // AGY Vault Save Note
  if (pathname === "/api/vault/note" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try {
        const { relPath, title, content } = JSON.parse(body || "{}");
        const targetPath = relPath ? path.join(VAULT_DIR, relPath) : path.join(VAULT_DIR, "00-Inbox", (title || "Note") + ".md");
        
        if (!targetPath.startsWith(VAULT_DIR)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Erişim engellendi." }));
          return;
        }

        const parentDir = path.dirname(targetPath);
        if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });

        fs.writeFileSync(targetPath, content || "", "utf-8");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", message: "Not kaydedildi.", path: path.relative(VAULT_DIR, targetPath) }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // AGY Vault Create Folder
  if (pathname === "/api/vault/folder" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try {
        const { folderPath } = JSON.parse(body || "{}");
        if (!folderPath) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "folderPath gereklidir." }));
          return;
        }
        const fullDir = path.join(VAULT_DIR, folderPath);
        if (!fullDir.startsWith(VAULT_DIR)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Geçersiz dizin." }));
          return;
        }
        if (!fs.existsSync(fullDir)) fs.mkdirSync(fullDir, { recursive: true });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", message: "Klasör oluşturuldu." }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // AGY Vault Delete Item
  if (pathname === "/api/vault/file" && req.method === "DELETE") {
    const relPath = parsedUrl.searchParams.get("path");
    if (!relPath) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "path parametresi zorunludur." }));
      return;
    }
    const full = path.join(VAULT_DIR, relPath);
    if (!full.startsWith(VAULT_DIR) || !fs.existsSync(full)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Öğe bulunamadı." }));
      return;
    }

    try {
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        fs.rmSync(full, { recursive: true, force: true });
      } else {
        fs.unlinkSync(full);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", message: "Silindi." }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Current Session Info
  if (pathname === "/api/session" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      session: currentSession,
      isGenerating: currentSession.isGenerating
    }));
    return;
  }

  // Status
  if (pathname === "/api/status" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      busy: currentSession.isGenerating,
      sessionId: currentSession.id,
      conversationId: currentSession.conversationId,
      messagesCount: currentSession.messages.length,
      time: new Date().toISOString()
    }));
    return;
  }

  // New Chat
  if (pathname === "/api/new-chat" && req.method === "POST") {
    const cleanSession = {
      id: null,
      conversationId: null,
      title: "Yeni Sohbet",
      messages: [],
      isGenerating: false,
      createdAt: new Date().toISOString()
    };
    if (!currentSession.isGenerating) {
      currentSession = cleanSession;
      broadcastSSE("session_reset", { session: cleanSession });
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", session: cleanSession }));
    return;
  }

  // Stop Generation (Guaranteed Immediate Kill)
  if (pathname === "/api/stop" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      let data = {};
      try { data = JSON.parse(body || "{}"); } catch (e) {}
      const targetConvId = data.conversationId;

      manualStop = true;
      if (targetConvId) {
        if (persistentWorkers.has(targetConvId)) {
          const w = persistentWorkers.get(targetConvId);
          if (w) w.destroy();
          persistentWorkers.delete(targetConvId);
        }
        if (activeProcesses.has(targetConvId)) {
          const proc = activeProcesses.get(targetConvId);
          if (proc && proc.child && proc.child.pid) {
            try {
              exec(`pkill -9 -P ${proc.child.pid} 2>/dev/null; kill -9 ${proc.child.pid} 2>/dev/null || true`);
              proc.child.kill("SIGKILL");
            } catch (e) {}
          }
          activeProcesses.delete(targetConvId);
        }
        broadcastSSE("generating_done", { conversationId: targetConvId, isGenerating: false });
        broadcastSSE("stopped", { message: "İşlem durduruldu.", conversationId: targetConvId });
      } else {
        for (const [cId, w] of persistentWorkers.entries()) {
          try { if (w) w.destroy(); } catch (e) {}
        }
        persistentWorkers.clear();
        for (const [cId, proc] of activeProcesses.entries()) {
          if (proc && proc.child && proc.child.pid) {
            try {
              exec(`pkill -9 -P ${proc.child.pid} 2>/dev/null; kill -9 ${proc.child.pid} 2>/dev/null || true`);
              proc.child.kill("SIGKILL");
            } catch (e) {}
          }
          broadcastSSE("generating_done", { conversationId: cId, isGenerating: false });
          broadcastSSE("stopped", { message: "İşlem durduruldu.", conversationId: cId });
        }
        activeProcesses.clear();
        if (activeChildProcess) {
          try { activeChildProcess.kill("SIGKILL"); } catch (e) {}
          activeChildProcess = null;
        }
      }
      currentSession.isGenerating = false;

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", message: "İşlem durduruldu." }));
    });
    return;
  }

  // Explicit In-Place Compaction Endpoint
  if (pathname === "/api/chat/compact" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try {
        const data = JSON.parse(body || "{}");
        const convId = data.conversationId || currentSession.conversationId || currentSession.id;
        const resStats = compactConversationTranscript(convId, 0, true);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", ...resStats }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Chat Execution (Spawns Antigravity Engine with Stream JSON)
  if (pathname === "/api/chat" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 5e6) req.destroy();
    });

    req.on("end", () => {
      try {
        const data = JSON.parse(body || "{}");
        let prompt = (data.prompt || "").trim();
        const reqConvId = (data.conversationId || data.sessionId || "").trim();
        const isExplicitNew = data.continue === false || reqConvId.length === 0;
        const continueChat = !isExplicitNew && reqConvId.length > 0;
        const targetConvId = continueChat ? reqConvId : "";

        const conversationId = targetConvId;

        // Check if user entered /compact slash command
        if (prompt === "/compact" || prompt.startsWith("/compact ")) {
          const convId = conversationId || currentSession.conversationId || currentSession.id;
          const compactRes = compactConversationTranscript(convId, 0, true);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", message: "Bağlam sıkıştırıldı.", ...compactRes }));
          return;
        }

        // Auto-Compact Check: If conversation exceeds threshold, compact before running agy
        if (continueChat && conversationId && data.autoCompact !== false) {
          const threshold = parseInt(data.compactThresholdTokens || 80000, 10);
          compactConversationTranscript(conversationId, threshold, false);
        }

        if (!continueChat) {
          currentSession = {
            id: null,
            conversationId: null,
            title: prompt.length > 35 ? prompt.slice(0, 35) + "…" : (prompt || "Yeni Sohbet"),
            messages: [],
            isGenerating: false,
            createdAt: new Date().toISOString()
          };
        } else {
          currentSession.conversationId = conversationId;
          currentSession.id = conversationId;
        }
        const model = (data.model || "").trim();
        const effort = (data.effort || "").trim();
        const mode = (data.mode || "").trim();
        const useVault = data.useVault !== false;
        const attachments = Array.isArray(data.attachments) ? data.attachments : [];

        if (!prompt && attachments.length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Prompt boş olamaz." }));
          return;
        }

        if (conversationId && activeProcesses.has(conversationId)) {
          res.writeHead(429, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Bu sohbet için şu anda başka bir yanıt üretiliyor. Lütfen bekleyin." }));
          return;
        }

        let attachmentNotice = "";
        if (attachments.length > 0) {
          const unreferencedAttachments = [];
          attachments.forEach((a, idx) => {
            const num = idx + 1;
            let safePath = a.path;
            if (!safePath || safePath.startsWith("/data/user/") || safePath.startsWith("/data/data/com.antigravity") || !safePath.startsWith("/data/data/com.termux/files/")) {
              safePath = path.join(UPLOADS_DIR, a.name ? path.basename(a.name) : "attachment");
            }
            const tagRegex = new RegExp(`\\[(image|resim|görsel|dosya|file|doc|ek)[-_]?${num}\\]`, "gi");
            const imgMeta = getImageMetadataAndOptimize(safePath);
            const metaSuffix = imgMeta ? ` (Meta: ${imgMeta.metaStr})` : "";
            
            if (tagRegex.test(prompt)) {
              prompt = prompt.replace(tagRegex, `[Ek Görsel/Dosya #${num} (${a.name}): ${safePath}${metaSuffix}]`);
            } else if (prompt.includes(safePath) || (a.name && prompt.includes(a.name))) {
              // Zaten metin içinde dosya yolundan veya adından açıkça bahsedilmiş
            } else {
              unreferencedAttachments.push({ ...a, resolvedPath: safePath });
            }
          });

          if (unreferencedAttachments.length > 0) {
            const fileRefs = unreferencedAttachments.map(a => {
              const safePath = a.resolvedPath || a.path || path.join(UPLOADS_DIR, a.name);
              const imgMeta = getImageMetadataAndOptimize(safePath);
              const metaSuffix = imgMeta ? ` [Meta: ${imgMeta.metaStr}]` : "";
              return "[Eklenen Dosya/Resim: " + safePath + "] (Adı: " + a.name + ")" + metaSuffix;
            }).join("\n");

            attachmentNotice = "\n\nKullanıcının mesaja eklediği diğer dosya ve görseller:\n" + fileRefs + "\nLütfen ekteki bu dosya/görselleri de analiz ederek yanıt verin.";
          }
        }

        const clientType = (data.client || "antigravity-android").trim();
        const isMobileClient = clientType.includes("android") || clientType.includes("mobile") || clientType === "antigravity-android";

        let clientContextInstruction = "";
        if (isMobileClient) {
          clientContextInstruction = `[Ortam Bilgisi & İstemci: Antigravity Android Mobil Uygulaması]
[Mobil Önizleme ve Formatlama Kuralları:
1. Dinamik Oturum Başlığı ve Proje Etiketi: Yanıtınızın KESİNLİKLE İLK SATIRINA (her şeyden önce), konuyu özetleyen 3-5 kelimelik Türkçe bir başlığı <!--__AGY_SESSION_TITLE: Örnek Konu Başlığı__--> formatında ekleyin. Eğer çalışılan/konuşulan konu belirli bir projeye aitse (örneğin antigravity-android, antigravity-termux-server, kpss-2026-lisans vb.), hemen yanına <!--__AGY_PROJECT_TAG: ProjeAdı__--> etiketini de ekleyin (Örnek: <!--__AGY_SESSION_TITLE: Kota Düzeltmesi__--><!--__AGY_PROJECT_TAG: antigravity-android__-->). Bu etiketler kullanıcı arayüzünde gizlenir, oturum listesi başlığını dinamik olarak günceller ve sohbeti projeye göre filtreleyip renklendirir.
2. Dosya ve Kod Bağlantıları: Referans verilen, düzenlenen veya oluşturulan her dosya/kod için mutlaka [dosya_adi.uzanti](file:///tam/dosya/yolu) formatında tıklanabilir bağlantı verin (örnek: [server.js](file:///data/data/com.termux/files/home/antigravity-termux-server/server.js)). Kullanıcı bağlantıya dokunduğunda mobil uygulamada dahili kod önizleyicisi ve editörü açılır.
3. Görseller & Şemalar: Oluşturulan, düzenlenen veya analiz edilen görselleri doğrudan ![Görsel Açıklaması](file:///tam/dosya/yolu.png) veya ![Görsel Açıklaması](/tam/dosya/yolu.png) formatında Markdown görsel etiketi olarak verin. Mobil uygulama bunları sohbet içinde interaktif önizleme kartı ve tam ekran yakınlaştırılabilir galeri olarak gösterir.
4. Uyarı & Vurgu Kutuları: GitHub callout formatını kullanın (> [!NOTE], > [!TIP], > [!IMPORTANT], > [!WARNING], > [!CAUTION]). Mobil uygulama bunları ikonlu ve renkli kutular olarak render eder.
5. Mermaid Şemaları: Akış şemalarında dikey mobil ekrana tam sığması ve yatay kaydırma gerektirmemesi için KESİNLİKLE dikey yönlendirme (\`flowchart TD\` veya \`graph TD\`) kullanın; yatay (\`flowchart LR\`, \`graph LR\`, \`RL\`) şemalar KESİNLİKLE KULLANILMAMALIDIR.
6. Tablolar & Veri Listeleri: Mobil ekranda yatay taşmayı önlemek için geniş çok kolonlu tablolardan kaçının; dikey anahtar-değer madde listeleri veya en fazla 2 kolonlu kompakt tablolar tercih edin. Kod parçalarını ise dil etiketli (\`\`\`kotlin, \`\`\`javascript, \`\`\`bash vb.) fenced block olarak sunun.
7. Net & Mobil Uyumlu Çıktı: Mobil ekran okunabilirliği için gereksiz dolgu metinlerinden kaçının, net ve yapılandırılmış bilgi sunun.
8. Etkileşimli Seçim ve Soru Kartları: Kullanıcıya seçenekli bir soru yöneltirken seçenekleri numaralı liste veya şıklar halinde sunun; kullanıcı doğrudan kart üzerinden dokunarak seçebilir veya "✍️ Yazarak Yanıtla" ile serbest yanıt girebilir.
9. İnteraktif Çoklu Seçim ve Tikli Liste Kartları: Kullanıcıya kurulacak paketler, MCP sunucuları, düzenlenecek dosyalar veya uygulanacak adımlar gibi çoklu seçenekler sunarken maddeleri standart Markdown checklist formatında (\`- [ ] Seçenek 1\`, \`- [ ] Seçenek 2\`) verin. Mobil uygulama bu listeyi dokunulabilir onay kutuları ve altında "Seçilenleri Gönder" butonu içeren interaktif bir seçim kartı olarak render eder.
10. Kesintisiz Görev ve Arka Plan Tamamlama Kuralı (Anti-Premature Exit - ZORUNLU): Bir komut (örneğin gh run watch, git commit/push, test, derleme, script vb.) veya alt-ajan çalıştırırken ASLA iş bitmeden "Arka planda izleniyor / bekleniyor" diyerek kullanıcıya ara mesaj verip TURU BİTİRMEYİN. Oturum CLI üzerinden tek turlu çalışır; siz ara metin yanıtı verdiğiniz an süreç sonlanır ve görev askıda kalır. İzleme komutlarını (watch, poll) ve görevleri doğrudan eşzamanlı olarak tamamlayın, tüm çıktıları toplayın ve kullanıcıya SADECE NİHAİ, TAMAMLANMIŞ sonucu raporlayın.
11. Alt-Ajan ve Süreç Sorumluluğu: Alt-ajan (\`invoke_subagent\`) veya arka plan görevi (\`run_command\`) başlattığınızda, alt-ajandan veya komuttan nihai sonuç gelene kadar turun açık kalmasını sağlayın; süreç bitmeden kullanıcıya yarım yanıt dönmeyin.]\n\n`;
        }

        const fullPromptForAgy = (clientContextInstruction + prompt + attachmentNotice).trim();

        const isContinue = continueChat && Boolean(conversationId);
        if (!isContinue) {
          currentSession = {
            id: null,
            conversationId: null,
            title: prompt.length > 35 ? prompt.slice(0, 35) + "…" : (prompt || "Yeni Sohbet"),
            messages: [],
            isGenerating: true
          };
        } else if (currentSession.messages.length === 0) {
          currentSession.title = prompt.length > 35 ? prompt.slice(0, 35) + "…" : (prompt || "Ekli Dosya Analizi");
        }

        currentSession.messages.push({
          role: "user",
          content: prompt || "(Dosya/Görsel Eklendi)",
          attachments: attachments,
          time: new Date().toISOString()
        });

        const botMessage = {
          role: "bot",
          content: "",
          tools: [],
          usage: null,
          time: new Date().toISOString(),
          state: "generating"
        };
        currentSession.messages.push(botMessage);
        currentSession.isGenerating = true;
        manualStop = false;

        let activeConvId = (isContinue ? conversationId : null) || currentSession.conversationId || currentSession.id || (Date.now().toString());
        broadcastSSE("generating_start", {
          conversationId: activeConvId,
          isGenerating: true
        });

        if (!res.headersSent) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "accepted", prompt }));
        }

        class PersistentWorker {
          constructor(opts) {
            this.convId = opts.convId || null;
            this.activeConvId = opts.convId || (Date.now().toString());
            this.model = opts.model || "";
            this.effort = opts.effort || "";
            this.mode = opts.mode || "";
            this.useVault = opts.useVault !== false;
            this.child = null;
            this.isReady = false;
            this.isBusy = false;
            this.currentBotMessage = null;
            this.currentPrompt = "";
            this.buffer = "";
            this.lastResultStatus = null;
            this.lastResultError = null;
            this.lastEventTs = Date.now();
            this.hasReceivedJsonEvents = false;
            this.hasStreamedChunk = false;
            this.numTurns = 0;
            this.diagStartTs = Date.now();
            this.diagPeakRssKb = 0;
            this.idleTimer = null;
            this.initWaiters = [];
            this.diagRssTimer = null;
          }

          start(attempt = 1) {
            if (manualStop) return;

            const args = [
              "--input-format", "stream-json",
              "--output-format", "stream-json",
              "--dangerously-skip-permissions",
              "--print-timeout", "60m"
            ];

            if (this.convId) {
              args.push("--conversation", this.convId);
            }

            if (this.model && this.model !== "default") {
              args.push("--model", this.model);
            }

            if (this.effort && ["low", "medium", "high"].includes(this.effort.toLowerCase())) {
              args.push("--effort", this.effort.toLowerCase());
            }

            if (this.mode && ["plan", "accept-edits"].includes(this.mode.toLowerCase())) {
              args.push("--mode", this.mode.toLowerCase());
            }

            if (this.useVault && fs.existsSync(VAULT_DIR)) {
              args.push("--add-dir", VAULT_DIR);
            }

            if (fs.existsSync(UPLOADS_DIR)) {
              args.push("--add-dir", UPLOADS_DIR);
            }

            const env = {
              ...process.env,
              CODEVIBE_ALLOW_FILE_KEYCHAIN: "1",
              HOME: "/data/data/com.termux/files/home",
              PREFIX: "/data/data/com.termux/files/usr",
              TMPDIR: "/data/data/com.termux/files/usr/tmp",
              LANG: "en_US.UTF-8",
              LC_ALL: "en_US.UTF-8",
              PATH: process.env.PATH || "/data/data/com.termux/files/usr/bin:/data/data/com.termux/files/usr/bin/applets",
              TERM: "xterm-256color",
              PAGER: "cat",
              SSL_CERT_FILE: "/data/data/com.termux/files/usr/etc/tls/cert.pem",
              GODEBUG: "netdns=cgo",
              AGY_AUTO_UPDATE: "0",
              TERMUX_VERSION: process.env.TERMUX_VERSION || "0.118.0"
            };
            for (const k of ["HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","http_proxy","https_proxy","all_proxy","NODE_TLS_REJECT_UNAUTHORIZED","GIT_SSL_NO_VERIFY"]) {
              delete env[k];
            }

            const agyPath = "/data/data/com.termux/files/usr/bin/agy";
            const child = spawn(agyPath, args, {
              cwd: process.env.HOME || "/data/data/com.termux/files/home",
              env: env
            });

            this.child = child;
            activeChildProcess = child;

            this.diagStartTs = Date.now();
            this.diagRssTimer = setInterval(() => {
              try {
                const rss = process.memoryUsage().rss;
                if (rss > this.diagPeakRssKb) this.diagPeakRssKb = rss;
              } catch (e) {}
            }, 2000);

            if (child.pid) {
              try {
                fs.appendFileSync("/data/data/com.termux/files/home/agy_diag.log",
                  `[${new Date().toISOString()}] spawn persistent pid=${child.pid} attempt=${attempt} convId=${this.convId} mem=${Math.round(process.memoryUsage().rss/1048576)}MB\n`);
              } catch (e) {}
              exec("taskset -p -c 0-5 " + child.pid + " 2>/dev/null; renice 15 -p " + child.pid + " 2>/dev/null");
            }

            child.stdout.on("data", (chunk) => {
              const raw = chunk.toString("utf-8");
              try { fs.appendFileSync("/data/data/com.termux/files/home/agy_stdout.log", raw); } catch (e) {}
              this.buffer += raw;

              const lines = this.buffer.split("\n");
              this.buffer = lines.pop();

              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;

                try {
                  const eventObj = JSON.parse(trimmed);
                  this.lastEventTs = Date.now();
                  this.hasReceivedJsonEvents = true;

                  if (eventObj.event === "init") {
                    if (eventObj.conversation_id) {
                      activeProcesses.delete(this.activeConvId);
                      if (this.convId) persistentWorkers.delete(this.convId);
                      this.convId = eventObj.conversation_id;
                      this.activeConvId = eventObj.conversation_id;
                      persistentWorkers.set(this.convId, this);
                      activeProcesses.set(this.activeConvId, { child, botMessage: this.currentBotMessage, activeConvId: this.activeConvId });
                      currentSession.conversationId = eventObj.conversation_id;
                      currentSession.id = eventObj.conversation_id;
                      broadcastSSE("init", { conversationId: eventObj.conversation_id });
                      broadcastSSE("generating_start", { conversationId: eventObj.conversation_id, isGenerating: true });
                    }
                    this.isReady = true;
                    while (this.initWaiters.length > 0) {
                      const cb = this.initWaiters.shift();
                      try { cb(); } catch (e) {}
                    }
                  } else if (eventObj.event === "step_update") {
                    const update = eventObj.step_update;
                    if (!update) continue;

                    if (update.text_delta && this.currentBotMessage) {
                      this.hasStreamedChunk = true;
                      this.currentBotMessage.content += update.text_delta;
                      broadcastSSE("chunk", {
                        text_delta: update.text_delta,
                        full_content: this.currentBotMessage.content,
                        conversationId: this.activeConvId
                      });
                    }

                    if ((update.tool_name || update.tool_info) && this.currentBotMessage) {
                      const toolInfo = update.tool_info || update;
                      const toolName = update.tool_name || toolInfo.name || toolInfo.tool_name || "tool";
                      const existingToolIndex = this.currentBotMessage.tools.findIndex(t => t.step_index === update.step_index);

                      const toolErr = (toolInfo && toolInfo.error) ? toolInfo.error : (update.error || null);
                      const toolErrMsg = toolErr ? (toolErr.message || (typeof toolErr === "string" ? toolErr : JSON.stringify(toolErr))) : null;
                      const rawState = update.state || toolInfo.state || (toolErr ? "ERROR" : "ACTIVE");
                      const up = String(rawState).toUpperCase();
                      const normState = (up === "DONE" || up === "SUCCESS" || up === "COMPLETED" || up === "FINISHED")
                        ? "DONE"
                        : (up === "ERROR" || up === "FAILED" || toolErr) ? "ERROR" : rawState;

                      const toolData = {
                        step_index: update.step_index,
                        name: toolName,
                        state: normState,
                        parameters: toolInfo.parameters || update.parameters || {},
                        output: toolInfo.output || update.output || null,
                        duration_seconds: update.duration_seconds || toolInfo.duration_seconds || null,
                        error: toolErrMsg
                      };

                      if (existingToolIndex >= 0) {
                        this.currentBotMessage.tools[existingToolIndex] = toolData;
                      } else {
                        this.currentBotMessage.tools.push(toolData);
                      }

                      broadcastSSE("tool_update", {
                        tool: toolData,
                        conversationId: this.activeConvId
                      });

                      if (toolName.includes("subagent")) {
                        getSubagentsForConversation(this.activeConvId).then(subs => {
                          if (subs.length > 0) {
                            broadcastSSE("subagents_update", {
                              conversationId: this.activeConvId,
                              subagents: subs
                            });
                          }
                        }).catch(() => {});
                      }
                      if (toolName.includes("task") || toolName === "run_command") {
                        getTasksForConversation(this.activeConvId).then(tsks => {
                          if (tsks.length > 0) {
                            broadcastSSE("tasks_update", {
                              conversationId: this.activeConvId,
                              tasks: tsks
                            });
                          }
                        }).catch(() => {});
                      }
                    }

                    if (update.usage && this.currentBotMessage) {
                      this.currentBotMessage.usage = update.usage;
                    }
                  } else if (eventObj.event === "result") {
                    const resObj = eventObj.result;
                    this.lastResultStatus = (resObj && resObj.status) ? String(resObj.status).toUpperCase() : null;
                    this.lastResultError = (resObj && resObj.error) ? String(resObj.error) : null;
                    if (typeof (resObj && resObj.num_turns) === "number") {
                      this.numTurns = resObj.num_turns;
                    }

                    if (this.currentBotMessage) {
                      if (resObj && resObj.response && (!this.currentBotMessage.content || this.currentBotMessage.content.trim().length === 0)) {
                        this.currentBotMessage.content = resObj.response;
                      }

                      if (resObj && resObj.usage) {
                        const activeContextTokens = calculateSessionContextTokens(currentSession);
                        const turnTokens = calculateTurnTokens(this.currentPrompt, this.currentBotMessage);
                        this.currentBotMessage.usage = {
                          input_tokens: resObj.usage.input_tokens > 0 ? resObj.usage.input_tokens : Math.max(1, Math.round((this.currentPrompt || "").length / 3.6)),
                          output_tokens: resObj.usage.output_tokens > 0 ? resObj.usage.output_tokens : Math.max(1, Math.round((this.currentBotMessage.content || "").length / 3.6)),
                          thinking_tokens: resObj.usage.thinking_tokens || 0,
                          cache_read_tokens: resObj.usage.cache_read_tokens || 0,
                          turn_tokens: turnTokens,
                          context_tokens: activeContextTokens,
                          total_tokens: activeContextTokens,
                          cumulative_tokens: resObj.usage.total_tokens || activeContextTokens
                        };
                      }

                      // Title & project tag update
                      if (this.activeConvId && this.currentBotMessage.content) {
                        const m = this.currentBotMessage.content.match(/<!--__AGY_SESSION_TITLE:\s*([^\n\r]+?)\s*__-->/) ||
                                  this.currentBotMessage.content.match(/<!--SESSION_TITLE:\s*([^\n\r]+?)\s*-->/);
                        if (m && m[1]) {
                          const newTitle = m[1].trim();
                          if (!isPlaceholderTitle(newTitle)) {
                            currentSession.title = newTitle;
                            const cached = brainConversationsCache.get(this.activeConvId);
                            if (cached) {
                              cached.title = newTitle;
                              brainConversationsCache.set(this.activeConvId, cached);
                            }
                            broadcastSSE("title_updated", { conversationId: this.activeConvId, title: newTitle });
                          }
                        }

                        const pm = this.currentBotMessage.content.match(/<!--__AGY_PROJECT_TAG:\s*([^\n\r]+?)\s*__-->/) ||
                                   this.currentBotMessage.content.match(/<!--__AGY_PROJECT:\s*([^\n\r]+?)\s*__-->/) ||
                                   this.currentBotMessage.content.match(/<!--PROJECT_TAG:\s*([^\n\r]+?)\s*-->/);
                        if (pm && pm[1]) {
                          const newProject = pm[1].trim().replace(/^\[|\]$/g, "");
                          if (newProject && newProject.length > 1 && !isPlaceholderTitle(newProject)) {
                            currentSession.projectName = newProject;
                            currentSession.projectTag = newProject;
                            const cached = brainConversationsCache.get(this.activeConvId);
                            if (cached) {
                              cached.projectName = newProject;
                              cached.projectTag = newProject;
                              brainConversationsCache.set(this.activeConvId, cached);
                            }
                            broadcastSSE("project_updated", { conversationId: this.activeConvId, projectName: newProject, projectTag: newProject });
                          }
                        }
                      }

                      this.currentBotMessage.state = "done";
                      broadcastSSE("done", {
                        exitCode: 0,
                        botMessage: this.currentBotMessage,
                        conversationId: this.activeConvId
                      });
                    }

                    this.isBusy = false;
                    currentSession.isGenerating = false;
                    activeProcesses.delete(this.activeConvId);
                    broadcastSSE("generating_done", { conversationId: this.activeConvId, isGenerating: false });
                    this.resetIdleTimer();
                  }
                } catch (err) {}
              }
            });

            child.stderr.on("data", (chunk) => {
              const stderrText = chunk.toString("utf-8");
              this.lastEventTs = Date.now();
              try { fs.appendFileSync("/data/data/com.termux/files/home/agy_stderr.log", stderrText); } catch (e) {}

              const authUrlMatch = stderrText.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/auth\S+/);
              if (authUrlMatch) {
                const detectedUrl = authUrlMatch[0];
                authWaitingChildProcess = child;
                broadcastSSE("auth_required", {
                  authUrl: detectedUrl,
                  error: "Google oturumu gerekiyor. Lütfen açılan tarayıcıda yetkilendirip kodu kopyalayın.",
                  isWaitingCode: true,
                  conversationId: this.activeConvId
                });
              }

              broadcastSSE("stderr", { text: stderrText, conversationId: this.activeConvId });
            });

            child.on("error", (err) => {
              this.cleanup();
              currentSession.isGenerating = false;
              broadcastSSE("generating_done", { conversationId: this.activeConvId, isGenerating: false });
              if (this.currentBotMessage) {
                this.currentBotMessage.state = "error";
                this.currentBotMessage.content += "\n\n⚠️ *Hata: " + err.message + "*";
              }
              broadcastSSE("error", { error: err.message, conversationId: this.activeConvId });
            });

            child.on("close", (code, signal) => {
              const wasBusy = this.isBusy;
              this.cleanup();

              if (manualStop) {
                manualStop = false;
                currentSession.isGenerating = false;
                broadcastSSE("generating_done", { conversationId: this.activeConvId, isGenerating: false });
                return;
              }

              if (wasBusy) {
                currentSession.isGenerating = false;
                broadcastSSE("generating_done", { conversationId: this.activeConvId, isGenerating: false });
                if (this.currentBotMessage && (!this.currentBotMessage.content || this.currentBotMessage.content.trim().length === 0)) {
                  this.currentBotMessage.state = "error";
                  this.currentBotMessage.content = "⚠️ *Üretim süreci sonlandı (exit " + code + ").*";
                  broadcastSSE("error", { error: this.lastResultError || "Process exited unexpectedly", conversationId: this.activeConvId });
                }
              }
            });
          }

          sendTurn(promptText, botMsg) {
            this.currentBotMessage = botMsg;
            this.currentPrompt = promptText;
            this.isBusy = true;
            this.hasStreamedChunk = false;
            this.lastResultStatus = null;
            this.lastResultError = null;
            if (this.idleTimer) clearTimeout(this.idleTimer);
            activeProcesses.set(this.activeConvId, { child: this.child, botMessage: botMsg, activeConvId: this.activeConvId });

            const doSend = () => {
              if (!this.child || this.child.exitCode !== null || !this.child.stdin || this.child.stdin.destroyed) {
                this.start(1);
                this.initWaiters.push(() => {
                  this.writePayload(promptText);
                });
              } else {
                this.writePayload(promptText);
              }
            };

            if (!this.isReady) {
              this.initWaiters.push(doSend);
            } else {
              doSend();
            }
          }

          writePayload(promptText) {
            try {
              const payload = JSON.stringify({
                event: "user",
                message: {
                  content: [{ type: "text", text: promptText }]
                }
              }) + "\n";
              this.child.stdin.write(payload);
            } catch (e) {
              this.cleanup();
            }
          }

          resetIdleTimer() {
            if (this.idleTimer) clearTimeout(this.idleTimer);
            this.idleTimer = setTimeout(() => {
              this.destroy();
            }, 30 * 60 * 1000);
          }

          cleanup() {
            if (this.diagRssTimer) clearInterval(this.diagRssTimer);
            if (this.idleTimer) clearTimeout(this.idleTimer);
            if (authWaitingChildProcess === this.child) authWaitingChildProcess = null;
            if (activeChildProcess === this.child) activeChildProcess = null;
            if (this.convId) persistentWorkers.delete(this.convId);
            activeProcesses.delete(this.activeConvId);
            this.isReady = false;
            this.isBusy = false;
          }

          destroy() {
            this.cleanup();
            if (this.child && this.child.exitCode === null) {
              try {
                this.child.stdin.end();
                setTimeout(() => {
                  if (this.child && this.child.exitCode === null) {
                    this.child.kill("SIGTERM");
                  }
                }, 1000);
              } catch (e) {}
            }
          }
        }

        async function handleChatExecution() {
          try {
            await checkAndRefreshToken();
          } catch (e) {}

          let switchNotice = null;
          try {
            const switchRes = checkAndAutoSwitchAccount();
            if (switchRes && switchRes.switched) {
              const fromLabel = switchRes.fromEmail ? `\`${switchRes.fromEmail}\`` : `\`${switchRes.from}\``;
              const toLabel = switchRes.toEmail ? `**\`${switchRes.toEmail}\`**` : `**\`${switchRes.to}\`**`;
              switchNotice = `> 🔄 **[Otomatik Hesap Geçişi]** ${fromLabel} hesabının kotası azaldığı için ${toLabel} hesabına geçildi.\n\n`;
              const targetId = conversationId || currentSession.conversationId;
              const existingWorker = targetId ? persistentWorkers.get(targetId) : null;
              if (existingWorker) {
                existingWorker.destroy();
                persistentWorkers.delete(targetId);
              }
              broadcastSSE("account_switched", {
                from: switchRes.from,
                to: switchRes.to,
                fromEmail: switchRes.fromEmail,
                toEmail: switchRes.toEmail,
                reason: switchRes.reason,
                conversationId: activeConvId
              });
            }
          } catch (e) {}

          const targetId = conversationId || currentSession.conversationId;
          let worker = targetId ? persistentWorkers.get(targetId) : null;

          // If worker exists but config changed (model/effort/mode), destroy and re-create
          if (worker && (worker.model !== model || worker.effort !== effort || worker.mode !== mode)) {
            worker.destroy();
            worker = null;
          }

          if (!worker) {
            worker = new PersistentWorker({
              convId: targetId,
              model: model,
              effort: effort,
              mode: mode,
              useVault: useVault
            });
            worker.start(1);
            if (targetId) persistentWorkers.set(targetId, worker);
          }

          if (switchNotice && botMessage) {
            botMessage.content = switchNotice;
            broadcastSSE("chunk", {
              text_delta: switchNotice,
              full_content: botMessage.content,
              conversationId: activeConvId
            });
          }

          worker.sendTurn(fullPromptForAgy, botMessage);
        }

        handleChatExecution();

      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Geçersiz istek: " + err.message }));
        }
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Endpoint Not Found", path: pathname }));
});

const previewServer = http.createServer(handlePreviewRequest);
previewServer.listen(PREVIEW_PORT, PREVIEW_HOST, () => {
  console.log("Preview server listening on http://" + PREVIEW_HOST + ":" + PREVIEW_PORT);
});

server.listen(PORT, HOST, () => {
  console.log("⚡ Antigravity Mobile IDE Backend listening on http://" + (HOST === "0.0.0.0" ? "localhost" : HOST) + ":" + PORT);
});
