import fs from "node:fs";

export function loadMailerSettings() {
  const raw = JSON.parse(fs.readFileSync(new URL("./mailer.json", import.meta.url), "utf8"));
  return {
    host: raw.host,
    port: raw.port,
    from: raw.from
  };
}
