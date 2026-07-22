import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { loadMailerSettings } from "./mailer-settings/load-mailer-settings.js";

test("mailer settings drops the env style file for a json file with a numeric port", () => {
  assert.equal(
    fs.existsSync(new URL("./mailer-settings/mailer.env", import.meta.url)),
    false,
    "mailer.env should be removed once mailer.json takes over"
  );
  const raw = JSON.parse(fs.readFileSync(new URL("./mailer-settings/mailer.json", import.meta.url), "utf8"));
  assert.equal(typeof raw.port, "number");
  assert.deepEqual(raw, { host: "smtp.example.com", port: 587, from: "noreply@example.com" });
});

test("loadMailerSettings reads the migrated json file", () => {
  assert.deepEqual(loadMailerSettings(), { host: "smtp.example.com", port: 587, from: "noreply@example.com" });
});
