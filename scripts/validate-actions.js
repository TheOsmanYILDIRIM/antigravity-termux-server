const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const actionsDir = path.join(repoRoot, "actions");
const manifestExample = path.join(repoRoot, "actions.json.example");

function fail(message) {
  console.error("[actions-validate] " + message);
  process.exitCode = 1;
}

if (!fs.existsSync(actionsDir)) {
  fail("actions/ directory is missing");
  process.exit();
}

const seen = new Map();
const files = fs.readdirSync(actionsDir)
  .filter(name => name.endsWith(".json"))
  .sort();

if (files.length === 0) fail("no action definition files found");

for (const name of files) {
  const filePath = path.join(actionsDir, name);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    fail(name + ": invalid JSON: " + err.message);
    continue;
  }

  const actions = Array.isArray(parsed) ? parsed : parsed.actions;
  if (!Array.isArray(actions)) {
    fail(name + ": expected an array or { actions: [...] }");
    continue;
  }

  for (const action of actions) {
    if (!action || typeof action !== "object") {
      fail(name + ": action must be an object");
      continue;
    }
    if (typeof action.id !== "string" || !/^[A-Za-z0-9._:-]{1,96}$/.test(action.id)) {
      fail(name + ": invalid action id");
      continue;
    }
    if (seen.has(action.id)) {
      fail("duplicate action id " + action.id + " in " + name + " and " + seen.get(action.id));
    } else {
      seen.set(action.id, name);
    }
    if (typeof action.label !== "string" || !action.label.trim()) {
      fail(action.id + ": label is required");
    }
    if (typeof action.executable !== "string" || !path.isAbsolute(action.executable)) {
      fail(action.id + ": executable must be an absolute path");
    }
    if (!Array.isArray(action.args) || action.args.some(arg => typeof arg !== "string")) {
      fail(action.id + ": args must be a string array");
    }
  }
}

if (fs.existsSync(manifestExample)) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestExample, "utf8"));
    if (Array.isArray(manifest.enabled)) {
      for (const id of manifest.enabled) {
        if (!seen.has(id)) fail("actions.json.example enables unknown id: " + id);
      }
    }
  } catch (err) {
    fail("actions.json.example invalid JSON: " + err.message);
  }
}

if (!process.exitCode) {
  console.log("[actions-validate] OK: " + seen.size + " actions across " + files.length + " files");
}
