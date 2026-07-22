import fs from "node:fs";

export function loadNotifierSettings() {
  const raw = JSON.parse(fs.readFileSync(new URL("./config.json", import.meta.url), "utf8"));
  return {
    channel: raw.notifier.channel,
    maxRetries: raw.notifier.maxRetries,
    muted: raw.notifier.muted
  };
}
