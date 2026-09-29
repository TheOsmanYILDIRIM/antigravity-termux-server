const path = require("path");
const { spawnSync } = require("child_process");
const { createActionRegistry } = require("../lib/actions");

const repoRoot = path.resolve(__dirname, "..");
const home = process.env.HOME || "/data/data/com.termux/files/home";
const actionId = process.argv[2] || "";

if (!/^[A-Za-z0-9._:-]{1,96}$/.test(actionId)) {
  console.error("Geçersiz action id");
  process.exit(2);
}

const registry = createActionRegistry({
  bundledDir: path.join(repoRoot, "actions"),
  userDir: path.join(home, ".config/terminal-hub/actions.d"),
  manifestPath: path.join(home, ".config/terminal-hub/actions.json")
});

const action = registry.getAction(actionId);
if (!action) {
  console.error("Action bulunamadı veya etkin değil: " + actionId);
  process.exit(3);
}

const result = spawnSync(action.executable, action.args, {
  cwd: home,
  env: { ...process.env, HOME: home },
  stdio: "inherit",
  shell: false
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(Number.isInteger(result.status) ? result.status : 1);
