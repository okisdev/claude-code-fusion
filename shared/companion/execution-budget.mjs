import { resolveCommandTransport } from "./raw-transport.mjs";

export function executionTimeoutMs(foregroundTimeoutMs, backgroundShell = false) {
  return backgroundShell ? 900000 : foregroundTimeoutMs;
}

export function resolveExecutionTransport(command, argv) {
  const flagIndex = argv[0] === "--transport-default-write" ? 1 : 0;
  if (command !== "task" || argv[flagIndex] !== "--transport-background-shell") {
    return resolveCommandTransport(argv);
  }
  const transportArgv = argv.toSpliced(flagIndex, 1);
  if (transportArgv[flagIndex] !== "--raw-args-token") {
    throw Object.assign(new Error("The background shell transport option requires a raw argument token."), { failureKind: "input" });
  }
  return { ...resolveCommandTransport(transportArgv), backgroundShell: true };
}
