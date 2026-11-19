import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildAgyChildEnv } from "../plugins/agy/scripts/lib/agy-exec.mjs";
import { browserBlockerDir, prepareGeminiDirectory, projectConfigFiles } from "../plugins/agy/scripts/lib/agy-home.mjs";

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agy-home-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("every run atomically replaces settings and MCP without touching real HOME", (t) => {
  const root = fixture(t);
  const dataDir = path.join(root, "data");
  const { geminiDir } = prepareGeminiDirectory({ dataDir });
  assert.equal(geminiDir, path.join(dataDir, "gemini"));
  const settings = path.join(geminiDir, "agy", "settings.json");
  const mcp = path.join(geminiDir, "config", "mcp_config.json");
  const conversation = path.join(geminiDir, "agy", "conversation.json");
  fs.writeFileSync(conversation, "session");
  fs.writeFileSync(settings, '{"trusted":true}');
  fs.writeFileSync(mcp, '{"mcpServers":{"evil":{}}}');
  const original = fs.renameSync;
  const replacements = [];
  fs.renameSync = (from, to) => {
    if ([settings, mcp].includes(to)) {
      replacements.push(to);
      assert.equal(fs.statSync(from).mode & 0o777, 0o600);
      assert.equal(path.dirname(from), path.dirname(to));
    }
    return original(from, to);
  };
  try { prepareGeminiDirectory({ dataDir }); }
  finally { fs.renameSync = original; }
  assert.deepEqual(replacements, [settings, mcp]);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings)), {});
  assert.deepEqual(JSON.parse(fs.readFileSync(mcp)), { mcpServers: {} });
  assert.equal(fs.readFileSync(conversation, "utf8"), "session");
  assert.equal(fs.existsSync(path.join(dataDir, "home")), false);
  for (const directory of [geminiDir, path.dirname(settings), path.dirname(mcp)]) assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
});

test("a private open shim fails so login never launches a browser", (t) => {
  const root = fixture(t);
  const { geminiDir } = prepareGeminiDirectory({ dataDir: path.join(root, "data") });
  const shim = path.join(browserBlockerDir(geminiDir), "open");
  assert.equal(fs.statSync(shim).mode & 0o777, 0o700);
  const result = spawnSync(shim, ["https://accounts.google.com/o/oauth2/auth"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout + result.stderr, "");
});

test("settings replacement does not follow a settings file symlink", (t) => {
  const dataDir = fixture(t);
  const { geminiDir } = prepareGeminiDirectory({ dataDir });
  const outside = path.join(dataDir, "user-settings");
  fs.writeFileSync(outside, "original");
  const settings = path.join(geminiDir, "agy", "settings.json");
  fs.unlinkSync(settings);
  fs.symlinkSync(outside, settings);
  assert.throws(() => prepareGeminiDirectory({ dataDir }), (error) => error.failureKind === "setup" && /symbolic link/.test(error.message));
  assert.equal(fs.readFileSync(outside, "utf8"), "original");
  assert.equal(fs.lstatSync(settings).isSymbolicLink(), true);
});

for (const entry of ["", "agy", "config", "bin", "agy/settings.json", "config/mcp_config.json", "bin/open"]) {
  for (const dangling of [false, true]) {
    test(`rejects ${dangling ? "dangling" : "existing"} symlink at gemini/${entry} before any write`, (t) => {
      const root = fixture(t);
      const dataDir = path.join(root, "data");
      const { geminiDir } = prepareGeminiDirectory({ dataDir });
      const originals = ["agy/settings.json", "config/mcp_config.json", "bin/open"];
      for (const file of originals) fs.writeFileSync(path.join(geminiDir, file), "private original");
      const destination = path.join(geminiDir, entry);
      const outside = path.join(root, "home", ".gemini");
      if (!dangling) {
        if (originals.includes(entry)) {
          fs.mkdirSync(path.dirname(outside), { recursive: true });
          fs.writeFileSync(outside, "user original", { mode: 0o644 });
        } else {
          for (const directory of ["agy", "config", "bin"]) fs.mkdirSync(path.join(outside, directory), { recursive: true, mode: 0o755 });
          for (const file of [...originals, "settings.json", "mcp_config.json", "open"]) fs.writeFileSync(path.join(outside, file), "user original", { mode: 0o644 });
        }
      }
      fs.rmSync(destination, { recursive: true, force: true });
      fs.symlinkSync(outside, destination);
      const mode = dangling ? null : fs.statSync(outside).mode;
      assert.throws(() => prepareGeminiDirectory({ dataDir }), (error) => error.failureKind === "setup" && error.message.includes(destination));
      assert.equal(fs.lstatSync(destination).isSymbolicLink(), true);
      if (dangling) assert.equal(fs.existsSync(outside), false);
      else {
        assert.equal(fs.statSync(outside).mode, mode);
        if (originals.includes(entry)) assert.equal(fs.readFileSync(outside, "utf8"), "user original");
        else for (const file of [...originals, "settings.json", "mcp_config.json", "open"]) assert.equal(fs.readFileSync(path.join(outside, file), "utf8"), "user original");
      }
      for (const file of originals) {
        if (entry && file !== entry && !file.startsWith(`${entry}/`)) assert.equal(fs.readFileSync(path.join(geminiDir, file), "utf8"), "private original");
      }
    });
  }
}

test("child env inherits the complete allowlist plus HOME and drops account and endpoint overrides", () => {
  const keys = ["HOME", "PATH", "LANG", "LANGUAGE", "TERM", "COLORTERM", "TMPDIR", "TZ", "USER", "LOGNAME", "SHELL", "LC_ALL", "LC_MESSAGES", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "JAVA_HOME", "GOROOT", "GOPATH", "CARGO_HOME", "RUSTUP_HOME", "PNPM_HOME", "BUN_INSTALL", "VOLTA_HOME", "MISE_DATA_DIR", "MISE_CONFIG_DIR", "MISE_CACHE_DIR", "ANDROID_HOME", "ANDROID_SDK_ROOT", "DEVELOPER_DIR", "SDKROOT"];
  const inherited = Object.fromEntries(keys.map((key) => [key, `/keep/${key}`]));
  const dropped = ["GEMINI_API_KEY", "GEMINI_ENDPOINT", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "ANTIGRAVITY_ACCOUNT", "AGY_BIN", "AGY_COMPANION_DATA", "AGY_MODEL", "CLOUDSDK_CONFIG", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "RUST_LOG", "DEVIN_MODEL", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GH_TOKEN", "DATABASE_URL", "SSH_AUTH_SOCK", "NODE_OPTIONS", "NODE_COMPILE_CACHE", "BASH_ENV", "CLAUDE_PLUGIN_ROOT"];
  const env = { ...inherited, ...Object.fromEntries(dropped.map((key) => [key, "drop"])) };
  assert.deepEqual(buildAgyChildEnv({ env }), inherited);
  assert.equal(env.AGY_MODEL, "drop");
});

test("macOS children receive the active developer directory so the git shim works inside the sandbox", () => {
  assert.equal(buildAgyChildEnv({ env: { PATH: "/usr/bin" }, platform: "linux" }).DEVELOPER_DIR, undefined);
  assert.equal(buildAgyChildEnv({ env: { DEVELOPER_DIR: "/chosen" }, platform: "darwin" }).DEVELOPER_DIR, "/chosen");
  if (process.platform === "darwin") assert.ok(buildAgyChildEnv({ env: { PATH: "/usr/bin" } }).DEVELOPER_DIR);
});

test("workspace advisories name only existing .gemini and .agents directories", (t) => {
  const cwd = fixture(t);
  assert.deepEqual(projectConfigFiles(cwd), []);
  fs.mkdirSync(path.join(cwd, ".gemini"));
  fs.writeFileSync(path.join(cwd, ".agents"), "file");
  assert.deepEqual(projectConfigFiles(cwd), [path.join(cwd, ".gemini")]);
  fs.unlinkSync(path.join(cwd, ".agents"));
  fs.mkdirSync(path.join(cwd, ".agents"));
  assert.deepEqual(projectConfigFiles(cwd), [path.join(cwd, ".gemini"), path.join(cwd, ".agents")]);
});
