import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs, parseRawArgs, splitRawArgumentString } from "../plugins/codex/scripts/lib/args.mjs";

test("raw argument splitting preserves contractions and groups quoted option values", () => {
  assert.deepEqual(splitRawArgumentString(`--focus="two words" don't detach`), [`--focus="two words"`, "don't", "detach"]);
  assert.deepEqual(splitRawArgumentString(`--focus 'two words'`), ["--focus", "'two words'"]);
});

test("raw argument splitting preserves prompt quotes and backslashes", () => {
  const raw = String.raw`rename "foo bar" and preserve \d+`;
  assert.deepEqual(splitRawArgumentString(raw), ["rename", `"foo bar"`, "and", "preserve", String.raw`\d+`]);
  assert.deepEqual(parseArgs(splitRawArgumentString(raw), {}), {
    options: {},
    positionals: ["rename", `"foo bar"`, "and", "preserve", String.raw`\d+`]
  });
});

test("raw argument splitting keeps unterminated prompt quotes opaque", () => {
  assert.deepEqual(splitRawArgumentString(`explain 'two words`), ["explain", "'two words"]);
  assert.equal(parseRawArgs(`  explain 'two words  `, {}).positionalText, `  explain 'two words  `);
  assert.throws(() => parseRawArgs(`--focus 'two words`, { valueOptions: ["focus"] }), /Unterminated quote in --focus value/);
});

test("argument parsing handles inline values and strict booleans", () => {
  const parsed = parseArgs(["--focus=two words", "--write=false", "prompt"], {
    valueOptions: ["focus"],
    booleanOptions: ["write"]
  });
  assert.deepEqual(parsed, { options: { focus: "two words", write: false }, positionals: ["prompt"] });
  assert.deepEqual(parseArgs([`--focus="two words"`], { valueOptions: ["focus"] }), {
    options: { focus: "two words" },
    positionals: []
  });
  assert.throws(
    () => parseArgs(["--write=maybe"], { booleanOptions: ["write"] }),
    /Invalid boolean value/
  );
});

test("argument parsing requires an explicit separator before option-shaped prompt text", () => {
  assert.throws(() => parseArgs(["--unknown"], {}), /Unknown option/);
  assert.deepEqual(parseArgs(["--", "--literal prompt"], {}), { options: {}, positionals: ["--literal prompt"] });
});

test("raw argument parsing preserves positional whitespace while removing surrounding options", () => {
  const prompt = String.raw`preserve  repeated spaces
	indentation and \d+`;
  const parsed = parseRawArgs(`--model "gpt test" --write ${prompt} --json`, {
    booleanOptions: ["json", "write"],
    valueOptions: ["model"]
  });
  assert.deepEqual(parsed, {
    options: { model: "gpt test", write: true, json: true },
    positionals: ["preserve", "repeated", "spaces", "indentation", "and", String.raw`\d+`],
    positionalText: prompt
  });
});

test("raw argument parsing preserves leading and trailing prompt whitespace", () => {
  const prompt = "  preserve $() and `backticks`\n\tnested 'quotes' and \"quotes\"  ";
  const parsed = parseRawArgs(`--model "gpt test" --write ${prompt} --json`, {
    booleanOptions: ["json", "write"],
    valueOptions: ["model"]
  });
  assert.equal(parsed.positionalText, prompt);
  assert.deepEqual(parsed.options, { model: "gpt test", write: true, json: true });
});

test("raw argument parsing treats an unmatched quote inside the prompt as data", () => {
  const prompt = "  inspect $(touch /tmp/never) and `echo never`\nkeep \\\\ and \"unmatched  ";
  const parsed = parseRawArgs(`--write ${prompt}`, { booleanOptions: ["write"] });
  assert.equal(parsed.positionalText, prompt);
  assert.equal(parsed.options.write, true);
});

test("raw argument parsing preserves a complete prompt after the option separator", () => {
  const prompt = "--literal  option\n\twith spacing";
  assert.deepEqual(parseRawArgs(`--write -- ${prompt}`, { booleanOptions: ["write", "background"] }), {
    options: { write: true },
    positionals: ["--literal", "option", "with", "spacing"],
    positionalText: prompt
  });
});

test("raw argument parsing rejects options that split prompt text", () => {
  assert.throws(() => parseRawArgs("first --write second", { booleanOptions: ["write"] }), /Options cannot split raw prompt text/);
});

test("task style parsing never promotes option shaped prompt suffixes", () => {
  const config = {
    booleanOptions: ["background", "network", "write"],
    optionsBeforePositionals: true,
    valueOptions: ["cwd", "model", "output-schema"]
  };
  const parsed = parseRawArgs("--write Fix support for --background --cwd /tmp/other --network", config);
  assert.deepEqual(parsed.options, { write: true });
  assert.equal(parsed.positionalText, "Fix support for --background --cwd /tmp/other --network");
  assert.deepEqual(parseArgs(["--write", "Fix support", "--background"], config), {
    options: { write: true },
    positionals: ["Fix support", "--background"]
  });
});

test("task style parsing accepts an output schema before the opaque prompt", () => {
  const parsed = parseRawArgs("--output-schema='schemas/verdict.json' inspect the change", {
    optionsBeforePositionals: true,
    valueOptions: ["output-schema"]
  });
  assert.deepEqual(parsed.options, { "output-schema": "schemas/verdict.json" });
  assert.equal(parsed.positionalText, "inspect the change");
});
