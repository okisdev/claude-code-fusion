import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { errorWithFailure } from "./companion-commands.mjs";
import { writePrivateStateFile } from "./companion-state.mjs";

export const GO_API_BASE_URL = "https://opencode.ai/inference/go/v1";

function absolute(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return path.isAbsolute(trimmed) ? trimmed : null;
}

export function opencodeAuthFile(env = process.env) {
  const dataHome = absolute(env.XDG_DATA_HOME) ?? path.join(absolute(env.HOME) ?? os.homedir(), ".local", "share");
  return path.join(dataHome, "opencode", "auth.json");
}

export function resolveApiKey(env = process.env) {
  const fromEnv = env.OPENCODE_GO_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  let entry;
  try { entry = JSON.parse(fs.readFileSync(opencodeAuthFile(env), "utf8"))?.["opencode-go"]; }
  catch { return null; }
  return entry?.type === "api" && typeof entry.key === "string" && entry.key.trim() ? entry.key.trim() : null;
}

export function requireApiKey(env = process.env) {
  const key = resolveApiKey(env);
  if (!key) throw errorWithFailure("Run opencode auth login and choose OpenCode Go, or set OPENCODE_GO_API_KEY.", "auth");
  return key;
}

function readCache(file, maxAgeMs, now) {
  try {
    const cached = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Number.isFinite(cached.fetchedAt) && now >= cached.fetchedAt && now - cached.fetchedAt < maxAgeMs) return cached;
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  return null;
}

async function request(endpoint, { env = process.env, sessionId = randomUUID(), fetch = globalThis.fetch } = {}) {
  const headers = { "x-opencode-session": sessionId };
  const key = endpoint === "usage" ? requireApiKey(env) : resolveApiKey(env);
  if (key) headers.Authorization = `Bearer ${key}`;
  let response;
  try { response = await fetch(`${GO_API_BASE_URL}/${endpoint}`, { headers, signal: AbortSignal.timeout(15000) }); }
  catch { throw errorWithFailure("OpenCode Go request failed.", "network"); }
  if (!response.ok) {
    const kind = [401, 403].includes(response.status) ? "auth" : response.status === 429 ? "rate_limited" : response.status === 402 ? "quota" : "error";
    throw errorWithFailure(`OpenCode Go returned HTTP ${response.status}.`, kind);
  }
  try { return await response.json(); }
  catch { throw errorWithFailure("OpenCode Go returned invalid JSON.", "error"); }
}

export async function readModels({ dataDir, maxAgeMs = 3600000, now = Date.now(), ...options }) {
  const file = path.join(dataDir, "models-cache.json");
  const cached = readCache(file, maxAgeMs, now);
  if (Array.isArray(cached?.models)) return { models: cached.models, source: "cache" };
  const body = await request("models", options);
  const listing = body.data ?? body.models;
  if (!Array.isArray(listing)) throw errorWithFailure("OpenCode Go returned no model listing.", "setup");
  const models = listing.filter((model) => model.capabilities?.tools?.supported === true).map((model) => {
    if (typeof model.id !== "string" || !model.id.trim() || !Number.isSafeInteger(model.limit?.context) || model.limit.context <= 0) {
      throw errorWithFailure("OpenCode Go returned invalid model metadata.", "setup");
    }
    const effort = model.capabilities.reasoning?.effort ?? [];
    if (!Array.isArray(effort) || effort.some((value) => typeof value !== "string" || !/^[a-z][a-z0-9_-]*$/.test(value))) {
      throw errorWithFailure("OpenCode Go returned invalid reasoning efforts.", "setup");
    }
    return { id: model.id, name: model.name ?? model.id, limit: { context: model.limit.context }, capabilities: { tools: true, reasoning: { effort } } };
  });
  if (!models.length) throw errorWithFailure("OpenCode Go returned no models supporting tools.", "setup");
  writePrivateStateFile(file, `${JSON.stringify({ models, fetchedAt: now })}\n`);
  return { models, source: "api" };
}

function resetDate(value) {
  const time = typeof value === "number" ? value * (value < 1e12 ? 1000 : 1) : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) && Number.isFinite(new Date(time).getTime()) ? new Date(time).toISOString() : null;
}

export function quotaPools(usage, now = Date.now()) {
  return ["rolling", "weekly", "monthly"].map((window) => {
    const value = usage[window] ?? {};
    const usedPercent = typeof value.percent === "number" && Number.isFinite(value.percent) && value.percent >= 0 ? value.percent : null;
    const resetsAt = resetDate(value.resetsAt);
    const reset = resetsAt ? Date.parse(resetsAt) : NaN;
    const monthlyStart = new Date(reset);
    monthlyStart.setUTCDate(1);
    monthlyStart.setUTCMonth(monthlyStart.getUTCMonth() - 1);
    const lastDay = new Date(Date.UTC(monthlyStart.getUTCFullYear(), monthlyStart.getUTCMonth() + 1, 0)).getUTCDate();
    monthlyStart.setUTCDate(Math.min(new Date(reset).getUTCDate(), lastDay));
    const windowMinutes = window === "rolling" ? 300 : window === "weekly" ? 10080 : Number.isFinite(reset) ? (reset - monthlyStart.getTime()) / 60000 : null;
    const elapsed = windowMinutes && Number.isFinite(reset) ? 1 - (reset - now) / (windowMinutes * 60000) : null;
    return { pool: "opencode", costClass: "included", usedPercent, windowMinutes, resetsAt,
      pacing: window !== "rolling" && usedPercent !== null && elapsed > 0 && elapsed <= 1 ? usedPercent / (100 * elapsed) : null };
  });
}

export async function readQuota({ dataDir, env = process.env, now = Date.now(), ...options }) {
  const report = { engine: "opencode", available: false, observedAt: new Date(now).toISOString(), pools: [], note: null };
  try { requireApiKey(env); }
  catch { return { ...report, note: "Run opencode auth login for OpenCode Go, or set OPENCODE_GO_API_KEY, to read OpenCode Go quota." }; }
  const file = path.join(dataDir, "quota-cache.json");
  const cached = readCache(file, 60000, now);
  if (cached?.report?.engine === "opencode" && Array.isArray(cached.report.pools)) return cached.report;
  try {
    const usage = (await request("usage", { env, ...options }))?.usage ?? {};
    if (!["rolling", "weekly", "monthly"].some((key) => usage[key] && typeof usage[key] === "object")) throw errorWithFailure("OpenCode Go returned no quota windows.", "error");
    report.available = true;
    report.pools = quotaPools(usage, now);
    writePrivateStateFile(file, `${JSON.stringify({ report, fetchedAt: now })}\n`);
  } catch (error) { report.note = error.message; }
  return report;
}

export function readProvider(command, { dataDir, maxAgeMs = 3600000, sessionId = randomUUID(), env = process.env }) {
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), command, dataDir, String(maxAgeMs), sessionId], {
    env, encoding: "utf8", timeout: 20000, maxBuffer: 2 * 1024 * 1024
  });
  let report;
  try { report = JSON.parse(result.stdout); } catch {}
  if (result.error || result.status !== 0 || !report) throw errorWithFailure(report?.message ?? "Could not read OpenCode Go provider metadata.", report?.failureKind ?? "error");
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, dataDir, maxAgeMs, sessionId] = process.argv.slice(2);
  try {
    const options = { dataDir, maxAgeMs: Number(maxAgeMs), sessionId };
    if (!["models", "quota"].includes(command)) throw errorWithFailure("Unknown provider operation.");
    const report = await (command === "models" ? readModels(options) : readQuota(options));
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ failureKind: error.failureKind ?? "error", message: error.message })}\n`);
    process.exitCode = 1;
  }
}
