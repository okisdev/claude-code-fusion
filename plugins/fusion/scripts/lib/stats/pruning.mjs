import fs from "node:fs";
import path from "node:path";
import { engineDataDir } from "../../lib/engines.mjs";
import { WORKSPACE_ENGINE_DESCRIPTORS, listWorkspaceEntries } from "./aggregation.mjs";
import { DAY_MS, PRUNE_EVIDENCE, isPathPositivelyAbsent, resolveFusionDataDir } from "./evidence.mjs";

function isWorkspaceDead(jobs, descriptor) {
  for (const raw of jobs) {
    if (descriptor.isLive(raw)) {
      return false;
    }
    const cwd = descriptor.cwdOf(raw);
    if (typeof cwd !== "string" || !cwd.trim() || !path.isAbsolute(cwd) || !isPathPositivelyAbsent(cwd)) {
      return false;
    }
  }
  return true;
}

function readPruneSnapshot(stateRoot, workspace) {
  const dir = path.join(stateRoot, workspace, "jobs");
  try {
    const initialStat = fs.statSync(dir);
    if (!initialStat.isDirectory()) {
      return null;
    }
    const entries = fs.readdirSync(dir).sort();
    const jobEntries = entries.filter((entry) => entry.endsWith(".json"));
    if (jobEntries.length === 0) {
      return null;
    }
    const jobs = jobEntries.map((entry) => JSON.parse(fs.readFileSync(path.join(dir, entry), "utf8")));
    const verifiedEntries = fs.readdirSync(dir).sort();
    const verifiedStat = fs.statSync(dir);
    if (initialStat.mtimeMs !== verifiedStat.mtimeMs || entries.length !== verifiedEntries.length || entries.some((entry, index) => entry !== verifiedEntries[index])) {
      return null;
    }
    return { dir, entries, jobs, mtimeMs: verifiedStat.mtimeMs };
  } catch {
    return null;
  }
}

function sameEntries(left, right) {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function stillSafeToPrune(candidate, descriptor) {
  const evidence = candidate[PRUNE_EVIDENCE];
  if (!evidence) {
    return false;
  }
  const current = readPruneSnapshot(evidence.stateRoot, candidate.workspace);
  return current !== null && current.mtimeMs === evidence.mtimeMs && sameEntries(current.entries, evidence.entries) && isWorkspaceDead(current.jobs, descriptor);
}

function scanDeadWorkspaces(descriptor, env) {
  const root = descriptor.resolveRoot(env);
  if (!fs.existsSync(root)) {
    return [];
  }
  const candidates = [];
  for (const workspace of listWorkspaceEntries(root)) {
    const snapshot = readPruneSnapshot(root, workspace);
    if (!snapshot || !isWorkspaceDead(snapshot.jobs, descriptor)) {
      continue;
    }
    const candidate = { workspace, dir: path.join(root, workspace), jobCount: snapshot.jobs.length };
    Object.defineProperty(candidate, PRUNE_EVIDENCE, {
      value: { stateRoot: root, entries: snapshot.entries, mtimeMs: snapshot.mtimeMs }
    });
    candidates.push(candidate);
  }
  return candidates;
}

function findUnusedAcceptanceObservations(env) {
  const root = path.join(resolveFusionDataDir(env), "observations");
  let workspaces;
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates = [];
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) {
      continue;
    }
    const file = path.join(root, workspace.name, "acceptance.jsonl");
    try {
      if (fs.lstatSync(file).isFile()) {
        candidates.push({ key: workspace.name, file });
      }
    } catch {
      void 0;
    }
  }
  return candidates;
}

function existingEngineJobIds(env, engines = WORKSPACE_ENGINE_DESCRIPTORS) {
  const ids = new Set();
  for (const descriptor of engines) {
    const root = descriptor.resolveRoot(env);
    for (const workspace of listWorkspaceEntries(root)) {
      const dir = path.join(root, workspace, "jobs");
      let entries;
      try { entries = fs.readdirSync(dir); } catch { continue; }
      for (const entry of entries) if (entry.endsWith(".json")) ids.add(entry.slice(0, -5));
    }
  }
  return ids;
}

function observationDirectoryJobs(dir) {
  const ids = new Set();
  const roots = new Set();
  let newestMtimeMs;
  try {
    newestMtimeMs = fs.lstatSync(dir).mtimeMs;
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (!fs.lstatSync(file).isFile()) return null;
      newestMtimeMs = Math.max(newestMtimeMs, fs.lstatSync(file).mtimeMs);
      if (!name.endsWith(".jsonl")) continue;
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { return null; }
        if (typeof entry.jobId === "string") ids.add(entry.jobId);
        const root = entry.workspaceRoot ?? entry.cwd;
        if (typeof root === "string" && path.isAbsolute(root)) roots.add(root);
      }
    }
  } catch { return null; }
  return { ids, roots, newestMtimeMs };
}

function observationDirectoryCandidate(dir, ageMs, requireDeadWorkspace, jobIds, now) {
  let stat;
  try { stat = fs.lstatSync(dir); } catch { return null; }
  if (!stat.isDirectory() || now - stat.mtimeMs < ageMs) return null;
  const evidence = observationDirectoryJobs(dir);
  if (!evidence || now - evidence.newestMtimeMs < ageMs || [...evidence.ids].some((id) => jobIds.has(id))) return null;
  if (requireDeadWorkspace && (evidence.roots.size === 0 || [...evidence.roots].some((root) => !isPathPositivelyAbsent(root)))) return null;
  return { key: path.basename(dir), dir, mtimeMs: stat.mtimeMs };
}

function scanObservationDirectories(env, ageMs, requireDeadWorkspace, now = Date.now()) {
  if (!env.FUSION_DATA_DIR && !env.HOME) return [];
  const base = path.join(resolveFusionDataDir(env), "observations");
  const jobIds = existingEngineJobIds(env);
  let entries;
  try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { return []; }
  return entries.filter((entry) => entry.isDirectory())
    .map((entry) => observationDirectoryCandidate(path.join(base, entry.name), ageMs, requireDeadWorkspace, jobIds, now))
    .filter(Boolean);
}

function cursorRunCandidate(dir, recorded, now) {
  const jobId = path.basename(dir);
  if (recorded.has(jobId)) return null;
  try {
    const stat = fs.lstatSync(dir);
    return stat.isDirectory() && now - stat.mtimeMs >= 60 * 60 * 1000 ? { jobId, dir, mtimeMs: stat.mtimeMs } : null;
  } catch { return null; }
}

function scanOrphanCursorRuns(env, now = Date.now()) {
  if (!env.CURSOR_COMPANION_DATA && !env.HOME) return [];
  const root = path.join(engineDataDir("cursor", env), "runs");
  const recorded = existingEngineJobIds(env, WORKSPACE_ENGINE_DESCRIPTORS.filter((entry) => entry.id === "cursor"));
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return entries.filter((entry) => entry.isDirectory())
    .map((entry) => cursorRunCandidate(path.join(root, entry.name), recorded, now))
    .filter(Boolean);
}

export function pruneOldObservationSidecars(env = process.env, now = Date.now()) {
  const dataDir = resolveFusionDataDir(env);
  const stamp = path.join(dataDir, ".observation-prune-stamp");
  try { if (now - fs.statSync(stamp).mtimeMs < DAY_MS) return []; } catch { void 0; }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const lockPath = `${stamp}.lock`;
  let lock;
  try { lock = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600); }
  catch (error) {
    if (error?.code !== "EEXIST") throw error;
    try {
      if (now - fs.statSync(lockPath).mtimeMs < 60 * 60 * 1000) return [];
      fs.rmSync(lockPath, { force: true });
      lock = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    } catch { return []; }
  }
  try {
    try { if (now - fs.statSync(stamp).mtimeMs < DAY_MS) return []; } catch { void 0; }
    const removed = [];
    const currentJobs = existingEngineJobIds(env);
    for (const candidate of scanObservationDirectories(env, 90 * DAY_MS, false, now)) {
      const current = observationDirectoryCandidate(candidate.dir, 90 * DAY_MS, false, currentJobs, now);
      if (!current || current.mtimeMs !== candidate.mtimeMs) continue;
      fs.rmSync(candidate.dir, { recursive: true, force: true });
      removed.push(candidate);
    }
    fs.writeFileSync(stamp, `${new Date(now).toISOString()}\n`, { mode: 0o600 });
    return removed;
  } finally {
    fs.closeSync(lock);
    fs.rmSync(lockPath, { force: true });
  }
}

export function findDeadWorkspaces(env = process.env) {
  const dead = {};
  for (const descriptor of WORKSPACE_ENGINE_DESCRIPTORS) {
    dead[descriptor.id] = scanDeadWorkspaces(descriptor, env);
  }
  dead.acceptance = findUnusedAcceptanceObservations(env);
  dead.observations = scanObservationDirectories(env, 30 * DAY_MS, true);
  dead.cursorRuns = scanOrphanCursorRuns(env);
  return dead;
}

export function pruneDeadWorkspaces({ env = process.env, yes = false, beforeRemove } = {}) {
  const dead = findDeadWorkspaces(env);
  if (!yes) {
    return { applied: false, dead };
  }
  const removed = {};
  for (const [engineId, candidates] of Object.entries(dead)) {
    if (engineId === "acceptance" || engineId === "observations" || engineId === "cursorRuns") {
      continue;
    }
    removed[engineId] = [];
    const descriptor = WORKSPACE_ENGINE_DESCRIPTORS.find((entry) => entry.id === engineId);
    for (const candidate of candidates) {
      if (beforeRemove) {
        beforeRemove(candidate, descriptor);
      }
      if (!descriptor || !stillSafeToPrune(candidate, descriptor)) {
        continue;
      }
      fs.rmSync(candidate.dir, { recursive: true, force: true });
      removed[engineId].push(candidate);
    }
  }
  const currentJobs = existingEngineJobIds(env);
  const currentCursorJobs = existingEngineJobIds(env, WORKSPACE_ENGINE_DESCRIPTORS.filter((entry) => entry.id === "cursor"));
  for (const key of ["observations", "cursorRuns"]) {
    removed[key] = [];
    for (const candidate of dead[key]) {
      const current = key === "observations"
        ? observationDirectoryCandidate(candidate.dir, 30 * DAY_MS, true, currentJobs, Date.now())
        : cursorRunCandidate(candidate.dir, currentCursorJobs, Date.now());
      if (!current || current.mtimeMs !== candidate.mtimeMs) continue;
      fs.rmSync(candidate.dir, { recursive: true, force: true });
      removed[key].push(candidate);
    }
  }
  removed.acceptance = [];
  for (const candidate of dead.acceptance ?? []) {
    try {
      if (!fs.lstatSync(candidate.file).isFile()) continue;
      fs.rmSync(candidate.file, { force: true });
      removed.acceptance.push(candidate);
    } catch { void 0; }
  }
  return { applied: true, dead: removed };
}
