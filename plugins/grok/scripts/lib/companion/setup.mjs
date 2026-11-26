import fs from "node:fs";
import { ensureGrokHome, grokPaths, spawnWithGrokAuth } from "../grok-home.mjs";
import { buildGrokChildEnv, existingUnixSockets, grokAuthStatus, runtimeSocketEndpoints, runtimeSocketEngine, runtimeSocketRemedy, runtimeSocketSymlinkEndpoints, undeniedRuntimeSocketCandidates, undeniedRuntimeSocketRemedy, resolveGrokBin, resolveGrokCapabilities } from "../grok-exec.mjs";
import { renderSetupReport } from "../render.mjs";
import { clearQuotaCooldown, ensurePrivateDataDir, resolveDataDir } from "../state.mjs";
import { TESTED_VERSION_MAX } from "./config.mjs";
import { probeGrokVersion, parseVersion, compareVersion, testedVersionInterval, supportedVersion, activeQuotaCooldown } from "./version.mjs";
import { output, readConfig, writeConfig, continuityPolicy, parseContinuityPolicy, commandArgs } from "./base.mjs";

const DOCTOR_PROBE_TIMEOUT_MS = 3000;
const SHELL_ENVIRONMENT_POLICY_DETAIL =
  "Grok supports [shell_environment_policy] (introduced in 0.2.112, verified through 1.0.30) to control which environment variables reach shell tools in write runs.";

function doctorCommandAdvisory(bin, available, paths) {
  if (!available) {
    return { available: false, detail: "grok is unavailable" };
  }
  const probe = spawnWithGrokAuth(paths, bin, ["doctor", "--help"], { encoding: "utf8", env: buildGrokChildEnv(), timeout: DOCTOR_PROBE_TIMEOUT_MS });
  const supported = !probe.error && probe.status === 0;
  return {
    available: supported,
    detail: supported ? "grok doctor is available" : "grok doctor is not available on this Grok CLI"
  };
}

function hostEnvironmentAdvisory(env = process.env, version = null) {
  try {
    const runtimeSocketSymlinks = runtimeSocketSymlinkEndpoints(runtimeSocketEndpoints({ env, version }), { env, version });
    const undeniedRuntimeSockets = existingUnixSockets(undeniedRuntimeSocketCandidates(env));
    const engine = runtimeSocketSymlinks.length === 0 ? null : runtimeSocketEngine(runtimeSocketSymlinks[0]);
    return {
      ready: runtimeSocketSymlinks.length === 0,
      writeReady: runtimeSocketSymlinks.length === 0 && undeniedRuntimeSockets.length === 0,
      runtimeSocketSymlinks,
      undeniedRuntimeSockets,
      runtimeSocketEngine: engine,
      remedy: runtimeSocketSymlinks.length > 0 ? runtimeSocketRemedy(runtimeSocketSymlinks[0], engine) : undeniedRuntimeSockets.length > 0 ? undeniedRuntimeSocketRemedy() : null,
      detail: runtimeSocketSymlinks.length === 0
        ? undeniedRuntimeSockets.length > 0
          ? `no blocking runtime-socket symlinks; socket ${undeniedRuntimeSockets[0]} may remain reachable from Grok's macOS strict sandbox even when listed in deny_paths, so write runs are refused while it could drive that container engine and write outside the workspace`
          : "no blocking runtime-socket symlinks"
        : `blocking runtime-socket symlinks: ${runtimeSocketSymlinks.join(", ")}`
    };
  } catch (error) {
    return {
      ready: false,
      writeReady: false,
      runtimeSocketSymlinks: [],
      undeniedRuntimeSockets: [],
      runtimeSocketEngine: null,
      remedy: null,
      detail: `unable to inspect runtime-socket deny paths: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

function handleSetup(argv, transport = {}) {
  const { options } = commandArgs(argv, {
    valueOptions: ["continuity"],
    booleanOptions: ["json", "enable-stop-gate", "disable-stop-gate", "clear-quota-cooldown"]
  }, transport);
  if (options["enable-stop-gate"] && options["disable-stop-gate"]) {
    throw new Error("Use either --enable-stop-gate or --disable-stop-gate, not both.");
  }
  const configuredContinuity =
    options.continuity === undefined ? null : parseContinuityPolicy(options.continuity);

  const paths = grokPaths();
  let present = false;
  let homeError;
  try {
    present = ensureGrokHome(paths);
  } catch (error) {
    homeError = error.message;
  }
  const bin = resolveGrokBin();
  const probe = probeGrokVersion(bin, process.env);
  const available = probe.available;
  const detail = available
    ? probe.rawVersion || "ok"
    : probe.errorMessage?.includes("ENOENT")
      ? "not found on PATH"
      : probe.rawVersion || probe.errorMessage || `exit ${probe.exitCode}`;
  const compatible = available && supportedVersion(probe.version);
  const installedVersion = parseVersion(probe.version);
  const newerThanTested = Boolean(installedVersion) && compareVersion(installedVersion, TESTED_VERSION_MAX) >= 0;
  const testedInterval = testedVersionInterval();

  const capabilityFlags = [
    "--prompt-file",
    "--output-format",
    "--sandbox",
    "--tools",
    "--disallowed-tools",
    "--deny",
    "--max-turns",
    "--no-auto-update",
    "--permission-mode",
    "--allow",
    "--disable-web-search",
    "--always-approve",
    "--json-schema",
    "--no-subagents",
    "--no-wait-for-background"
  ];
  let capabilities = { ready: false, detail: available ? "capability probe did not run" : "grok is unavailable", flags: {} };
  if (available && !homeError) {
    try {
      const supported = resolveGrokCapabilities(bin, process.env);
      const flags = Object.fromEntries(capabilityFlags.map((flag) => [flag, supported.has(flag)]));
      const critical = capabilityFlags.filter((flag) => flag !== "--no-subagents");
      const missing = critical.filter((flag) => !flags[flag]);
      capabilities = {
        ready: missing.length === 0,
        detail: missing.length === 0 ? "required headless safety capabilities are available" : `missing ${missing.join(", ")}`,
        flags
      };
    } catch (error) {
      capabilities = { ready: false, detail: error instanceof Error ? error.message : String(error), flags: {} };
    }
  }

  const doctorCommand = doctorCommandAdvisory(bin, available && !homeError, paths);
  const shellEnvironmentPolicy = {
    available: !homeError,
    present,
    detail: homeError ?? `${SHELL_ENVIRONMENT_POLICY_DETAIL} The [shell_environment_policy] table is ${present ? "present" : "not present"}. Presence does not prove the policy restricts the write-run shell environment.`
  };
  const hostEnvironment = hostEnvironmentAdvisory(process.env, probe.version);
  const auth = grokAuthStatus();

  const dataDir = resolveDataDir();
  if (options["clear-quota-cooldown"]) clearQuotaCooldown(dataDir);
  const quotaCooldown = activeQuotaCooldown(dataDir);
  let writable = true;
  let writeDetail = dataDir;
  try {
    ensurePrivateDataDir(dataDir);
    fs.accessSync(dataDir, fs.constants.W_OK);
  } catch (error) {
    writable = false;
    writeDetail = error instanceof Error ? error.message : String(error);
  }

  if (options["enable-stop-gate"]) {
    writeConfig(dataDir, { stopGate: true });
  } else if (options["disable-stop-gate"]) {
    writeConfig(dataDir, { stopGate: false });
  }
  if (configuredContinuity) {
    writeConfig(dataDir, { continuityPolicy: configuredContinuity });
  }

  const nextSteps = [];
  if (!available) {
    nextSteps.push("Install the grok CLI and make sure `grok --version` works, or point GROK_BIN at the binary.");
  }
  if (available && !homeError && !capabilities.ready) {
    nextSteps.push("Upgrade the grok CLI to a build that exposes the required headless safety capabilities.");
  }
  if (available && newerThanTested) {
    nextSteps.push(`Grok CLI version ${probe.version} is newer than the tested interval (${testedInterval}); run a verification pass.`);
  } else if (available && !compatible) {
    nextSteps.push(installedVersion ? `Use a Grok CLI version in the tested interval (${testedInterval}).` : "Could not parse grok --version output; verify the installed Grok CLI.");
  }
  if (quotaCooldown) nextSteps.push(`Grok quota cooldown is active until ${quotaCooldown.expiresAt}, set by job ${quotaCooldown.jobId}: ${quotaCooldown.message}. Run /grok:setup --clear-quota-cooldown to clear it.`);
  if (!hostEnvironment.ready && hostEnvironment.runtimeSocketSymlinks.length > 0) {
    nextSteps.push(hostEnvironment.remedy ?? runtimeSocketRemedy(hostEnvironment.runtimeSocketSymlinks[0], hostEnvironment.runtimeSocketEngine));
  }
  if (hostEnvironment.ready && !hostEnvironment.writeReady) {
    nextSteps.push(hostEnvironment.remedy);
  }
  if (!writable) {
    nextSteps.push(`Fix permissions on ${dataDir}.`);
  }
  if (auth.stale) {
    nextSteps.push("Run `grok models` once outside the sandbox to refresh the stored Grok token.");
  }
  if (homeError) nextSteps.push(homeError);

  const ready = available && capabilities.ready && compatible && hostEnvironment.ready && writable && !homeError && !quotaCooldown;
  const report = {
    ready,
    writeReady: ready && hostEnvironment.writeReady,
    grok: { available, detail, bin },
    compatibility: newerThanTested ? `newer than the tested interval (${testedInterval})` : compatible ? "tested" : available ? `outside the tested interval (${testedInterval})` : "unknown",
    quotaCooldown,
    capabilities,
    doctorCommand,
    shellEnvironmentPolicy,
    privateHome: { path: paths.home, ready: !homeError, userPluginsAndHooksExcluded: !homeError },
    hostEnvironment,
    auth,
    dataDir: { path: dataDir, writable, detail: writeDetail },
    stopGate: Boolean(readConfig(dataDir).stopGate),
    continuityPolicy: continuityPolicy(dataDir),
    nextSteps
  };
  output(options.json ? report : renderSetupReport(report), options.json);
}

export { handleSetup };
