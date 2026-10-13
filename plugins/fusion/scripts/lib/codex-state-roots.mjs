import { engineStateRoots } from "./engines.mjs";

export function resolveCodexStateRoots(env = process.env) {
  return engineStateRoots("codex", env);
}

export function resolveCodexStateDir(env = process.env) {
  return resolveCodexStateRoots(env)[0];
}
