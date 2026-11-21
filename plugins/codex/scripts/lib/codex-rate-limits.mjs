import { spawn } from "node:child_process";

function windowFromAccount(window) {
  if (!window || typeof window !== "object") return null;
  return { used_percent: window.usedPercent, window_minutes: window.windowDurationMins ?? null, resets_at: window.resetsAt ?? null };
}

export function observationFromAccountRateLimits(result, observedAt) {
  const limits = result?.rateLimitsByLimitId?.codex ?? result?.rateLimits;
  if (!limits || typeof limits !== "object") return null;
  return {
    observedAt,
    rateLimits: { plan_type: limits.planType ?? null, primary: windowFromAccount(limits.primary), secondary: windowFromAccount(limits.secondary) }
  };
}

export function readAccountRateLimits({ bin = "codex", env = process.env, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    let child;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child?.kill("SIGKILL"); } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      child = spawn(bin, ["app-server"], { env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    } catch {
      finish(null);
      return;
    }
    const send = (message) => {
      try { child.stdin.write(`${JSON.stringify(message)}\n`); } catch { finish(null); }
    };
    child.on("error", () => finish(null));
    child.on("exit", () => finish(null));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message?.id === 1) {
          if (message.error) return finish(null);
          send({ method: "initialized" });
          send({ id: 2, method: "account/rateLimits/read", params: null });
        } else if (message?.id === 2) {
          finish(message.error ? null : observationFromAccountRateLimits(message.result, new Date().toISOString()));
        }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "codex-companion", version: "0" } } });
  });
}
