import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseArgs, parseRawArgs } from "../plugins/codex/scripts/lib/args.mjs";

test("Codex argument parsing keeps option-shaped values from consuming known short options", () => {
  const config = { valueOptions: ["cwd", "model"] };
  assert.throws(() => parseArgs(["--cwd", "-model=test"], config), { message: "Missing value for --cwd." });
  assert.throws(() => parseRawArgs("--cwd -model=test", config), { message: "Missing value for --cwd." });
});

test("Codex locks honor live legacy reaper claims and recover their dead successors", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-shared-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "ps"), '#!/bin/sh\nprintf "process\\n"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "sysctl"), '#!/bin/sh\nprintf "{ sec = 1, usec = 0 }\\n"\n', { mode: 0o755 });
  const source = `
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const [stateUrl, identityUrl, dataDir] = process.argv.slice(1);
const { withThreadLock } = await import(stateUrl);
const { getProcessIdentity } = await import(identityUrl);
const identity = getProcessIdentity(process.pid);
assert.ok(identity);
const replaced = { ...identity, commandHash: "0".repeat(64) };
const threadId = "legacy-reaper";
const key = createHash("sha256").update(threadId).digest("hex");
const lock = path.join(dataDir, "locks", "threads", key + ".lock");
fs.mkdirSync(path.dirname(lock), { recursive: true });
function owner(slot, token, ownerIdentity) {
  const dir = slot + ".owner." + token;
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify({ version: 1, token, ownerPid: process.pid, ownerIdentity }));
  fs.symlinkSync(path.basename(dir), slot, "dir");
  return dir;
}
const deadToken = "a".repeat(32);
const claimToken = "b".repeat(32);
const successorToken = "c".repeat(32);
const deadDir = owner(lock, deadToken, replaced);
const claim = deadDir + ".reap";
const claimDir = owner(claim, claimToken, identity);
assert.throws(() => withThreadLock(dataDir, threadId, () => assert.fail("live reaper was ignored")), /Timed out waiting for the job record lock/);
assert.equal(fs.existsSync(lock), true);
assert.equal(fs.existsSync(claim), true);
fs.writeFileSync(path.join(claimDir, "owner.json"), JSON.stringify({ version: 1, token: claimToken, ownerPid: process.pid, ownerIdentity: replaced }));
owner(claim + "-successor-" + claimToken, successorToken, replaced);
assert.equal(withThreadLock(dataDir, threadId, () => "recovered"), "recovered");
assert.deepEqual(fs.readdirSync(path.dirname(lock)), []);
process.stdout.write("recovered");
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source,
    new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href,
    new URL("../plugins/codex/scripts/lib/process-identity.mjs", import.meta.url).href,
    path.join(root, "data")], {
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, CODEX_COMPANION_LOCK_TIMEOUT_MS: "200" }
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(result.stdout, "recovered");
});
