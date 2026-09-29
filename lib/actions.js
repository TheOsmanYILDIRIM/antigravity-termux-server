const fs = require("fs");
const path = require("path");

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
    order: Number.isFinite(raw.order) ? raw.order : 0,
    schedulable: raw.schedulable === true,
    alwaysEnabled: raw.alwaysEnabled === true
  };
}

function readActionDefinitionsFromDir(directory, sourceName = "actions") {
  const out = [];
  if (!fs.existsSync(directory)) return out;

  let files = [];
  try {
    files = fs.readdirSync(directory)
      .filter(name => name.endsWith(".json"))
      .sort((a, b) => a.localeCompare(b));
  } catch (err) {
    console.error(`[ACTIONS] Cannot list ${sourceName} directory:`, err.message);
    return out;
  }

  for (const name of files) {
    const filePath = path.join(directory, name);
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const candidates = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed.actions)
          ? parsed.actions
          : [parsed];
      for (const candidate of candidates) {
        const action = normalizeAction(candidate);
        if (action) out.push(action);
        else console.error(`[ACTIONS] Invalid action definition skipped: ${filePath}`);
      }
    } catch (err) {
      console.error(`[ACTIONS] Invalid JSON skipped: ${filePath}: ${err.message}`);
    }
  }

  return out;
}

function createActionRegistry({ bundledDir, userDir, manifestPath }) {
  function getCatalog() {
    const catalog = new Map();
    for (const action of readActionDefinitionsFromDir(bundledDir, "bundled")) {
      catalog.set(action.id, action);
    }
    for (const action of readActionDefinitionsFromDir(userDir, "local")) {
      catalog.set(action.id, action);
    }
    return Object.fromEntries(catalog.entries());
  }

  function getActions() {
    const catalog = getCatalog();
    if (!fs.existsSync(manifestPath)) return catalog;

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

      // Legacy external manifest actions remain supported for migration.
      if (Array.isArray(manifest.actions)) {
        for (const raw of manifest.actions) {
          const action = normalizeAction(raw);
          if (action) catalog[action.id] = action;
        }
      }

      if (!Array.isArray(manifest.enabled)) return catalog;
      const enabled = new Set(manifest.enabled.filter(id => typeof id === "string"));
      return Object.fromEntries(
        Object.entries(catalog).filter(([id, action]) => enabled.has(id) || action.alwaysEnabled === true)
      );
    } catch (err) {
      console.error("[ACTIONS] Invalid manifest; using discovered catalog:", err.message);
      return catalog;
    }
  }

  function getAction(id) {
    if (typeof id !== "string") return null;
    return getActions()[id] || null;
  }

  return { getActions, getAction, getCatalog };
}

module.exports = {
  normalizeAction,
  readActionDefinitionsFromDir,
  createActionRegistry
};
