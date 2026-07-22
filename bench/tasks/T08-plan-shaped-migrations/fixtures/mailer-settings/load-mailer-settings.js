import fs from "node:fs";

export function loadMailerSettings() {
  const raw = fs.readFileSync(new URL("./mailer.env", import.meta.url), "utf8");
  const values = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const separatorIndex = trimmed.indexOf("=");
    const key = trimmed.slice(0, separatorIndex);
    const value = trimmed.slice(separatorIndex + 1);
    values[key] = value;
  }
  return {
    host: values.MAILER_HOST,
    port: Number(values.MAILER_PORT),
    from: values.MAILER_FROM
  };
}
