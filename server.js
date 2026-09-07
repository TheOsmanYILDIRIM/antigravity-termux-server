const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn, exec } = require("child_process");

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
const DATA_DIR = path.join(__dirname, "data");
const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
const UPLOADS_DIR = "/data/data/com.termux/files/home/uploads";
const VAULT_DIR = "/data/data/com.termux/files/home/agy-vault";
const AGENTS_SKILLS_DIR = "/data/data/com.termux/files/home/.agents/skills";
const BUILTIN_SKILLS_DIR = "/data/data/com.termux/files/home/.gemini/antigravity-cli/builtin/skills";
const BRAIN_DIR = "/data/data/com.termux/files/home/.gemini/antigravity-cli/brain";
const MODELS_CACHE_FILE = path.join(DATA_DIR, "models_cache.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(VAULT_DIR)) fs.mkdirSync(VAULT_DIR, { recursive: true });

let activeChildProcess = null;
let authWaitingChildProcess = null;
let pendingPkce = null;
let manualStop = false;
let sseClients = [];

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
    } else {
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

function refreshAgyModels() {
  if (activeChildProcess) return;
  const glibcCmd = "/data/data/com.termux/files/usr/glibc/lib/ld-linux-aarch64.so.1 --library-path /data/data/com.termux/files/usr/glibc/lib /data/data/com.termux/files/usr/bin/agy.va39 models 2>/dev/null";
  const cmd = fs.existsSync("/data/data/com.termux/files/usr/bin/agy.va39") ? glibcCmd : "AGY_AUTO_UPDATE=0 agy models 2>/dev/null";
  exec(cmd, { env: { ...process.env, CODEVIBE_ALLOW_FILE_KEYCHAIN: "1", AGY_AUTO_UPDATE: "0" }, timeout: 35000 }, (err, stdout) => {
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

// Model listesini sadece önbellek dosyası yoksa veya boşsa arka planda tazele;
if (!fs.existsSync(MODELS_CACHE_FILE)) {
  refreshAgyModels();
}

// Brain Conversations Reader (True IDE / CLI Shared Memory)
function getBrainConversations() {
  const list = [];
  try {
    if (!fs.existsSync(BRAIN_DIR)) return list;
    const entries = fs.readdirSync(BRAIN_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const convId = entry.name;
      const transcriptFile = path.join(BRAIN_DIR, convId, ".system_generated/logs/transcript.jsonl");
      if (!fs.existsSync(transcriptFile)) continue;

      try {
        const stats = fs.statSync(transcriptFile);
        const content = fs.readFileSync(transcriptFile, "utf-8");
        const lines = content.split("\n").filter(l => l.trim().length > 0);
        let title = "Antigravity IDE Sohbeti";
        let createdAt = stats.mtime.toISOString();
        let messageCount = 0;

        for (const line of lines) {
          try {
            const step = JSON.parse(line);
            if (step.type === "USER_INPUT") {
              messageCount++;
              if (title === "Antigravity IDE Sohbeti" && step.content) {
                let clean = step.content;
                const reqMatch = clean.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
                if (reqMatch && reqMatch[1]) {
                  clean = reqMatch[1];
                }
                clean = clean.replace(/<[^>]+>/g, "").trim();
                clean = clean.replace(/\s+/g, " ").trim();
                if (clean) {
                  title = clean.length > 45 ? clean.slice(0, 45) + "…" : clean;
                }
                if (step.created_at) createdAt = step.created_at;
              }
            } else if (step.type === "PLANNER_RESPONSE" && (step.content || step.tool_calls)) {
              messageCount++;
            }
          } catch (e) {}
        }

        list.push({
          id: convId,
          title: title,
          createdAt: createdAt,
          lastMessageTime: stats.mtime.toISOString(),
          messageCount: messageCount
        });
      } catch (err) {}
    }

    list.sort((a, b) => new Date(b.lastMessageTime) - new Date(a.lastMessageTime));
  } catch (e) {
    console.error("Error reading brain conversations:", e);
  }
  return list;
}

function loadBrainConversation(id) {
  if (!id) return null;
  const transcriptFile = path.join(BRAIN_DIR, id, ".system_generated/logs/transcript.jsonl");
  if (!fs.existsSync(transcriptFile)) return null;

  try {
    const content = fs.readFileSync(transcriptFile, "utf-8");
    const lines = content.split("\n").filter(l => l.trim().length > 0);
    const messages = [];
    let title = "Antigravity IDE Sohbeti";

    for (const line of lines) {
      try {
        const step = JSON.parse(line);
        if (step.type === "USER_INPUT") {
          let text = step.content || "";
          const reqMatch = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
          if (reqMatch && reqMatch[1]) {
            text = reqMatch[1].trim();
          } else {
            text = text.replace(/<[^>]+>/g, "").trim();
          }
          if (title === "Antigravity IDE Sohbeti" && text) {
            title = text.length > 45 ? text.slice(0, 45) + "…" : text;
          }
          messages.push({
            role: "user",
            content: text,
            time: step.created_at || new Date().toISOString()
          });
        } else if (step.type === "PLANNER_RESPONSE" || step.type === "MODEL") {
          let botContent = step.content || "";
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
          messages.push({
            role: "bot",
            content: botContent,
            tools: tools,
            time: step.created_at || new Date().toISOString(),
            state: "done"
          });
        }
      } catch (e) {}
    }

    return {
      id: id,
      conversationId: id,
      title: title,
      messages: messages,
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

const initialBrainList = getBrainConversations();
if (initialBrainList.length > 0) {
  const latestBrain = loadBrainConversation(initialBrainList[0].id);
  if (latestBrain) { currentSession = latestBrain; currentSession.isGenerating = false; }
}

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

function getVaultFiles(dirPath, baseRelative = "") {
  let results = [];
  try {
    if (!fs.existsSync(dirPath)) return results;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const rel = baseRelative ? (baseRelative + "/" + entry.name) : entry.name;
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        results.push({ name: entry.name, path: rel, isDirectory: true });
        if (!baseRelative.includes("/")) {
          results = results.concat(getVaultFiles(full, rel));
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
    case ".txt":
    case ".md":
    case ".kt":
    case ".java":
    case ".py":
    case ".js":
    case ".ts":
    case ".jsx":
    case ".tsx":
    case ".html":
    case ".css":
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
    } else if (hasFile(".git")) {
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

// Usage Metrics (Real transcript & token computation)
let cachedUsageMetrics = null;
let lastUsageCalculatedAt = 0;

function computeCLIUsageMetrics() {
  const now = Date.now();
  if (cachedUsageMetrics && (now - lastUsageCalculatedAt < 60 * 1000)) {
    return cachedUsageMetrics;
  }

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalThinkingTokens = 0;
  let totalTokens = 0;
  let recent5hTokens = 0;
  let recent5hTurns = 0;
  let weeklyTurns = 0;
  const fiveHoursMs = 5 * 60 * 60 * 1000;

  try {
    if (fs.existsSync(BRAIN_DIR)) {
      const convFolders = fs.readdirSync(BRAIN_DIR);
      for (const folder of convFolders) {
        const transcriptFile = path.join(BRAIN_DIR, folder, ".system_generated/logs/transcript.jsonl");
        if (fs.existsSync(transcriptFile)) {
          const content = fs.readFileSync(transcriptFile, "utf-8");
          const lines = content.split("\n");
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const item = JSON.parse(line);
              const time = item.created_at ? new Date(item.created_at).getTime() : now;
              let tok = 0;

              if (item.usage && item.usage.total_tokens) {
                tok = item.usage.total_tokens;
                totalInputTokens += (item.usage.input_tokens || 0);
                totalOutputTokens += (item.usage.output_tokens || 0);
                totalThinkingTokens += (item.usage.thinking_tokens || 0);
              } else {
                const inChars = (item.type === "USER_INPUT" ? (item.content || "").length : 0);
                const outChars = (item.type === "PLANNER_RESPONSE" || item.type === "MODEL" ? (item.content || "").length : 0);
                const thinkChars = (item.thinking || "").length;
                const toolChars = (item.type === "RUN_COMMAND" || item.type === "VIEW_FILE" ? (item.content || "").length : 0);

                const inTok = Math.ceil(inChars / 3.8);
                const outTok = Math.ceil(outChars / 3.8);
                const thinkTok = Math.ceil(thinkChars / 3.8);
                const toolTok = Math.ceil(toolChars / 3.8);
                tok = inTok + outTok + thinkTok + toolTok;

                totalInputTokens += inTok + toolTok;
                totalOutputTokens += outTok;
                totalThinkingTokens += thinkTok;
              }

              if (tok > 0) {
                totalTokens += tok;
                weeklyTurns++;
                if (now - time <= fiveHoursMs) {
                  recent5hTokens += tok;
                  recent5hTurns++;
                }
              }
            } catch (e) {}
          }
        }
      }
    }
  } catch (e) {}

  let lastTurnUsage = null;
  if (currentSession && Array.isArray(currentSession.messages)) {
    const lastBot = [...currentSession.messages].reverse().find(m => m.role === "bot" && m.usage);
    if (lastBot) lastTurnUsage = lastBot.usage;
  }

  const standard5hQuota = 500000;
  const standardWeeklyQuota = 5000000;
  const used5hPercent = Math.min(100, Math.round((recent5hTokens / standard5hQuota) * 100));
  const remaining5hPercent = Math.max(0, 100 - used5hPercent);
  const usedWeeklyPercent = Math.min(100, Math.round((totalTokens / standardWeeklyQuota) * 100));
  const remainingWeeklyPercent = Math.max(0, 100 - usedWeeklyPercent);

  cachedUsageMetrics = {
    recent5h: {
      totalTokens: recent5hTokens,
      turnCount: recent5hTurns,
      usedPercent: used5hPercent,
      remainingPercent: remaining5hPercent,
      windowHours: 5
    },
    weekly: {
      totalTokens: totalTokens,
      turnCount: weeklyTurns,
      usedPercent: usedWeeklyPercent,
      remainingPercent: remainingWeeklyPercent,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      thinkingTokens: totalThinkingTokens
    },
    lastTurn: lastTurnUsage,
    lastUpdated: new Date().toISOString()
  };
  lastUsageCalculatedAt = now;
  return cachedUsageMetrics;
}

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  const pathname = parsedUrl.pathname;

  // SSE Stream
  if (pathname === "/api/events" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });

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

  // Model Quota & Usage
  if (pathname === "/api/usage" && req.method === "GET") {
    const usage = computeCLIUsageMetrics();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", usage }));
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
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "ok",
          fileName: safeName,
          path: filePath,
          relPath: relPath,
          workspacePath: workspaceCopy,
          size: buffer.length,
          type: type || "file"
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

  // List Conversations (Direct from Brain)
  if (pathname === "/api/conversations" && req.method === "GET") {
    const list = getBrainConversations();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      currentSessionId: currentSession.conversationId || currentSession.id,
      conversations: list
    }));
    return;
  }

  // Export All Conversations (Full JSON / Markdown archive)
  if (pathname === "/api/export/all" && req.method === "GET") {
    try {
      const convList = getBrainConversations();
      const allSessions = [];
      for (const meta of convList) {
        const full = loadBrainConversation(meta.id);
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

  // Load Specific Conversation
  if (pathname.startsWith("/api/conversations/") && req.method === "GET") {
    const convId = pathname.replace("/api/conversations/", "").trim();
    const brainSession = loadBrainConversation(convId);
    if (brainSession) {
      currentSession = brainSession;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", session: currentSession }));
      broadcastSSE("session_loaded", { session: currentSession });
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
        fs.rmSync(convFolder, { recursive: true, force: true });
      }

      const list = getBrainConversations();
      if (currentSession.conversationId === convId || currentSession.id === convId) {
        if (list.length > 0) {
          const next = loadBrainConversation(list[0].id);
          currentSession = next || { id: null, conversationId: null, title: "Yeni Sohbet", messages: [], isGenerating: false };
        } else {
          currentSession = { id: null, conversationId: null, title: "Yeni Sohbet", messages: [], isGenerating: false };
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", conversations: list }));
      broadcastSSE("session_loaded", { session: currentSession });
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
    if (activeChildProcess) {
      try { activeChildProcess.kill("SIGINT"); } catch (e) {}
      activeChildProcess = null;
    }
    currentSession = {
      id: null,
      conversationId: null,
      title: "Yeni Sohbet",
      messages: [],
      isGenerating: false,
      createdAt: new Date().toISOString()
    };
    broadcastSSE("session_reset", { session: currentSession });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", session: currentSession }));
    return;
  }

  // Stop Generation (Guaranteed Immediate Kill)
  if (pathname === "/api/stop" && req.method === "POST") {
    manualStop = true;
    if (activeChildProcess) {
      const pid = activeChildProcess.pid;
      try {
        if (pid) {
          exec(`pkill -9 -P ${pid} 2>/dev/null; kill -9 ${pid} 2>/dev/null || true`);
        }
        activeChildProcess.kill("SIGKILL");
      } catch (e) {}
      activeChildProcess = null;
    }
    currentSession.isGenerating = false;
    broadcastSSE("stopped", { message: "İşlem durduruldu." });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", message: "İşlem anında durduruldu." }));
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
        const targetConvId = (data.conversationId || data.sessionId || currentSession.conversationId || currentSession.id || "").trim();
        const continueChat = data.continue !== false && targetConvId.length > 0;
        if (targetConvId) {
          currentSession.conversationId = targetConvId;
          currentSession.id = targetConvId;
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

        if (currentSession.isGenerating) {
          res.writeHead(429, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Asistan şu anda başka bir yanıt üretiyor. Lütfen bekleyin." }));
          return;
        }

        let attachmentNotice = "";
        if (attachments.length > 0) {
          const unreferencedAttachments = [];
          attachments.forEach((a, idx) => {
            const num = idx + 1;
            const safePath = a.path || path.join(UPLOADS_DIR, a.name);
            const tagRegex = new RegExp(`\\[(image|resim|görsel|dosya|file|doc|ek)[-_]?${num}\\]`, "gi");
            
            if (tagRegex.test(prompt)) {
              prompt = prompt.replace(tagRegex, `[Ek Görsel/Dosya #${num} (${a.name}): ${safePath}]`);
            } else if (prompt.includes(safePath) || (a.name && prompt.includes(a.name))) {
              // Zaten metin içinde dosya yolundan veya adından açıkça bahsedilmiş
            } else {
              unreferencedAttachments.push(a);
            }
          });

          if (unreferencedAttachments.length > 0) {
            const fileRefs = unreferencedAttachments.map(a => {
              const safePath = a.path || path.join(UPLOADS_DIR, a.name);
              return "[Eklenen Dosya/Resim: " + safePath + "] (Adı: " + a.name + ")";
            }).join("\n");

            attachmentNotice = "\n\nKullanıcının mesaja eklediği diğer dosya ve görseller:\n" + fileRefs + "\nLütfen ekteki bu dosya/görselleri de analiz ederek yanıt verin.";
          }
        }

        const fullPromptForAgy = (prompt + attachmentNotice).trim();

        if (currentSession.messages.length === 0) {
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

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "accepted", prompt }));

        async function startChatProcess(attempt = 1) {
          if (manualStop) return;

          try {
            await checkAndRefreshToken();
          } catch (e) {}

          if (attempt > 1) {
            botMessage.content = "";
            botMessage.tools = [];
          }

          const args = [
            "-p", fullPromptForAgy,
            "--dangerously-skip-permissions",
            "--output-format", "stream-json",
            "--print-timeout", "60m"
          ];

          if (continueChat && currentSession.conversationId) {
            args.push("--conversation", currentSession.conversationId);
          }

          if (model && model !== "default") {
            args.push("--model", model);
          }

          if (effort && ["low", "medium", "high"].includes(effort.toLowerCase())) {
            args.push("--effort", effort.toLowerCase());
          }

          if (mode && ["plan", "accept-edits"].includes(mode.toLowerCase())) {
            args.push("--mode", mode.toLowerCase());
          }

          if (useVault && fs.existsSync(VAULT_DIR)) {
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

          const diagStartTs = Date.now();
          let diagPeakRssKb = 0;
          const diagRssTimer = setInterval(() => {
            try {
              const rss = process.memoryUsage().rss;
              if (rss > diagPeakRssKb) diagPeakRssKb = rss;
            } catch (e) {}
          }, 2000);

          if (child.pid) {
            try {
              fs.appendFileSync("/data/data/com.termux/files/home/agy_diag.log",
                `[${new Date().toISOString()}] spawn pid=${child.pid} attempt=${attempt} args=${JSON.stringify(args)} mem=${Math.round(process.memoryUsage().rss/1048576)}MB\n`);
            } catch (e) {}
            exec("taskset -p -c 0-5 " + child.pid + " 2>/dev/null; renice 15 -p " + child.pid + " 2>/dev/null");
          }

          activeChildProcess = child;

          let buffer = "";
          let lastResultStatus = null;
          let lastResultError = null;
          let lastEventTs = Date.now();
          let hasReceivedJsonEvents = false;
          let hasStreamedChunk = false;
          let numTurns = 0;
          let killedByWatchdog = false;
          let watchdog = null;

          child.stdout.on("data", (chunk) => {
            const raw = chunk.toString("utf-8");
            try { fs.appendFileSync("/data/data/com.termux/files/home/agy_stdout.log", raw); } catch (e) {}
            buffer += raw;

            const lines = buffer.split("\n");
            buffer = lines.pop();

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;

              try {
                const eventObj = JSON.parse(trimmed);
                lastEventTs = Date.now();
                hasReceivedJsonEvents = true;

                if (eventObj.event === "init") {
                  if (eventObj.conversation_id) {
                    currentSession.conversationId = eventObj.conversation_id;
                    currentSession.id = eventObj.conversation_id;
                    broadcastSSE("init", { conversationId: eventObj.conversation_id });
                  }
                } else if (eventObj.event === "step_update") {
                  const update = eventObj.step_update;
                  if (!update) continue;

                  if (update.text_delta) {
                    hasStreamedChunk = true;
                    botMessage.content += update.text_delta;
                    broadcastSSE("chunk", {
                      text_delta: update.text_delta,
                      full_content: botMessage.content
                    });
                  }

                  if (update.tool_name || update.tool_info) {
                    const toolInfo = update.tool_info || update;
                    const toolName = update.tool_name || toolInfo.name || toolInfo.tool_name || "tool";
                    const existingToolIndex = botMessage.tools.findIndex(t => t.step_index === update.step_index);

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
                      botMessage.tools[existingToolIndex] = toolData;
                    } else {
                      botMessage.tools.push(toolData);
                    }

                    broadcastSSE("tool_update", { tool: toolData });
                  }

                  if (update.usage) {
                    botMessage.usage = update.usage;
                  }
                } else if (eventObj.event === "result") {
                  const resObj = eventObj.result;
                  lastResultStatus = (resObj && resObj.status) ? String(resObj.status).toUpperCase() : null;
                  lastResultError = (resObj && resObj.error) ? String(resObj.error) : null;
                  if (typeof (resObj && resObj.num_turns) === "number") {
                    numTurns = resObj.num_turns;
                  }

                  if (resObj && resObj.response) {
                    botMessage.content = resObj.response;
                  }
                  if (resObj && resObj.usage) {
                    botMessage.usage = resObj.usage;
                  }
                  if (resObj && resObj.conversation_id) {
                    currentSession.conversationId = resObj.conversation_id;
                    currentSession.id = resObj.conversation_id;
                  }
                }
              } catch (err) {}
            }
          });

          child.stderr.on("data", (chunk) => {
            const stderrText = chunk.toString("utf-8");
            lastEventTs = Date.now();
            try { fs.appendFileSync("/data/data/com.termux/files/home/agy_stderr.log", stderrText); } catch (e) {}

            // Detect agy requesting OAuth authorization
            const authUrlMatch = stderrText.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/auth\S+/);
            if (authUrlMatch) {
              const detectedUrl = authUrlMatch[0];
              authWaitingChildProcess = child;
              broadcastSSE("auth_required", {
                authUrl: detectedUrl,
                error: "Google oturumu gerekiyor. Lütfen açılan tarayıcıda yetkilendirip kodu kopyalayın.",
                isWaitingCode: true
              });
            }

            broadcastSSE("stderr", { text: stderrText });
          });

          child.on("error", (err) => {
            if (watchdog) clearInterval(watchdog);
            if (diagRssTimer) clearInterval(diagRssTimer);
            if (authWaitingChildProcess === child) authWaitingChildProcess = null;
            activeChildProcess = null;
            currentSession.isGenerating = false;
            try {
              fs.appendFileSync("/data/data/com.termux/files/home/agy_diag.log",
                `[${new Date().toISOString()}] ERR ${err.message} mem=${Math.round(process.memoryUsage().rss/1048576)}MB\n`);
            } catch (e) {}
            botMessage.state = "error";
            botMessage.content += "\n\n⚠️ *Hata: " + err.message + "*";
            broadcastSSE("error", { error: err.message });
          });

          child.on("close", (code, signal) => {
            if (watchdog) clearInterval(watchdog);
            if (diagRssTimer) clearInterval(diagRssTimer);
            if (authWaitingChildProcess === child) authWaitingChildProcess = null;
            activeChildProcess = null;

            if (child.pid) {
              try {
                fs.appendFileSync("/data/data/com.termux/files/home/agy_diag.log",
                  `[${new Date().toISOString()}] CLOSE pid=${child.pid} code=${code} signal=${signal} lastResultStatus=${lastResultStatus} durS=${Math.round((Date.now()-diagStartTs)/1000)} peakRss=${(diagPeakRssKb/1048576).toFixed(1)}MB attempt=${attempt}\n`);
              } catch (e) {}
            }

            if (manualStop) {
              manualStop = false;
              currentSession.isGenerating = false;
              return;
            }

            const errStr = String(lastResultError || "").toLowerCase();
            const isTransientAuthError = (
              (lastResultStatus === "ERROR" && (/authentication failed or timed out|network error|econnreset|etimedout|socket hang up/i.test(errStr))) ||
              (code !== 0 && !hasReceivedJsonEvents && !hasStreamedChunk)
            ) && !hasStreamedChunk && numTurns === 0;

            if (isTransientAuthError && attempt < 2) {
              try {
                fs.appendFileSync("/data/data/com.termux/files/home/agy_diag.log",
                  `[${new Date().toISOString()}] AUTO_RETRY triggered (attempt ${attempt} -> ${attempt + 1}) due to transient auth/socket error: "${lastResultError || 'exit_' + code}"\n`);
              } catch (e) {}
              setTimeout(() => {
                startChatProcess(attempt + 1);
              }, 600);
              return;
            }

            currentSession.isGenerating = false;

            const tokenFile = "/data/data/com.termux/files/home/.gemini/antigravity-cli/antigravity-oauth-token";
            let tokenFileExists = false;
            try {
              tokenFileExists = fs.existsSync(tokenFile) && fs.statSync(tokenFile).size > 10;
            } catch (e) {}

            const isExplicitPermanentAuth = (/please log in|not logged into antigravity|oauth_token_revoked|invalid_grant|unauthorized_client/i.test(errStr)) || (!tokenFileExists && /authentication failed|login required/i.test(errStr));

            if (isExplicitPermanentAuth) {
              botMessage.state = "error";
              botMessage.content = "⚠️ *AGY kimlik doğrulaması gerekiyor. Lütfen ayarlar üzerinden terminal ile tekrar giriş yapın.*";
              broadcastSSE("auth_required", { error: lastResultError || "Kimlik doğrulaması gerekli.", needsReauth: true });
              broadcastSSE("stopped", { reason: "auth_required" });
              return;
            }

            const isSuccess = lastResultStatus === "SUCCESS";
            const failed = !isSuccess || killedByWatchdog;

            if (failed) {
              let errMsg = lastResultError;
              let isAgentLimit = false;

              if (errMsg && /agent execution terminated due to error/i.test(errMsg)) {
                isAgentLimit = true;
                if (botMessage.tools && botMessage.tools.length > 0) {
                  errMsg = "Ajan oturum adım/token sınırına ulaştı (Agent limit). Yapılan araç çağrıları ve dosya değişiklikleri başarıyla uygulandı. Sohbet geçmişi çok uzadığı için yeni bir sohbet başlatmanız önerilir.";
                } else {
                  errMsg = "Ajan oturum veya token sınırı nedeniyle sonlandırıldı (Agent execution limit). Sohbet geçmişi dolmuş olabilir, lütfen yeni bir sohbet ('+ Yeni Sohbet') başlatmayı deneyin.";
                }
              } else if (!errMsg) {
                if (killedByWatchdog) {
                  errMsg = "Üretim zaman aşımına uğradı: uzun süredir aktivite gelmedi (donmuş komut veya backend takılması olabilir). İşlem durduruldu.";
                } else if (lastResultStatus) {
                  errMsg = "Üretim başarısız oldu (durum: " + lastResultStatus + (code ? ", exit " + code : "") + ")";
                } else if (code === null && signal) {
                  const sigName = String(signal).toUpperCase().startsWith("SIG") ? String(signal) : "SIG" + signal;
                  errMsg = "Üretim süreci " + sigName + " sinyaliyle sonlandırıldı (" + sigName + " = OOM/bellek baskısı veya dış müdahale). Sonuç alınamadı.";
                } else {
                  errMsg = "Üretim beklenmeden sonlandı (sonuç alınamadı, exit " + code + ").";
                }
              }

              botMessage.state = isAgentLimit && botMessage.tools.length > 0 ? "done" : "error";
              if (!botMessage.content || !botMessage.content.trim()) {
                botMessage.content = "⚠️ *" + errMsg + "*";
              } else {
                botMessage.content += "\n\n⚠️ *" + errMsg + "*";
              }
              broadcastSSE(isAgentLimit && botMessage.tools.length > 0 ? "done" : "error", {
                error: errMsg,
                exitCode: code,
                fatal: !isAgentLimit,
                botMessage: botMessage
              });
            } else {
              botMessage.state = "done";
              broadcastSSE("done", {
                exitCode: code,
                botMessage: botMessage
              });
            }
          });
        }

        startChatProcess(1);

      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Geçersiz istek: " + err.message }));
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Endpoint Not Found", path: pathname }));
});

server.listen(PORT, HOST, () => {
  console.log("⚡ Antigravity Mobile IDE Backend listening on http://" + (HOST === "0.0.0.0" ? "localhost" : HOST) + ":" + PORT);
});
