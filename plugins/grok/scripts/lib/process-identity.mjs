import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";

let cachedOwnIdentity;
let cachedBootMarker;

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function directProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function linuxProcessIdentity(pid) {
  let stat;
  let command;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    command = fs.readFileSync(`/proc/${pid}/cmdline`);
  } catch {
    return null;
  }
  let bootId = cachedBootMarker;
  if (!bootId) {
    try {
      bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    } catch {
      return null;
    }
    if (bootId) {
      cachedBootMarker = bootId;
    }
  }
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd === -1 || !bootId) {
    return null;
  }
  const fields = stat.slice(commandEnd + 2).trim().split(/\s+/);
  const startMarker = fields[19];
  if (!/^\d+$/.test(startMarker ?? "")) {
    return null;
  }
  return {
    version: 1,
    platform: "linux",
    bootMarker: bootId,
    startMarker,
    commandHash: digest(command)
  };
}

function bsdBootMarker(env) {
  if (cachedBootMarker) {
    return cachedBootMarker;
  }
  const boot = process.platform === "darwin"
    ? spawnSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8", env, timeout: 2000, windowsHide: true })
    : spawnSync("uptime", ["-s"], { encoding: "utf8", env, timeout: 2000, windowsHide: true });
  const bootValue = String(boot.stdout ?? "").trim();
  if (boot.status !== 0 || !bootValue) {
    return null;
  }
  const darwinBoot = process.platform === "darwin" ? bootValue.match(/\bsec\s*=\s*(\d+)\s*,\s*usec\s*=\s*(\d+)\b/) : null;
  cachedBootMarker = darwinBoot ? `${darwinBoot[1]}.${darwinBoot[2]}` : digest(bootValue);
  return cachedBootMarker;
}

function bsdProcessIdentity(pid) {
  const env = { ...process.env, LANG: "C", LC_ALL: "C", TZ: "UTC" };
  const started = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    env,
    timeout: 2000,
    windowsHide: true
  });
  const command = spawnSync("ps", ["-ww", "-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    env,
    timeout: 2000,
    windowsHide: true
  });
  const bootMarker = bsdBootMarker(env);
  const startMarker = String(started.stdout ?? "").trim().replace(/\s+/g, " ");
  const commandValue = String(command.stdout ?? "").trim();
  if (started.status !== 0 || command.status !== 0 || !bootMarker || !startMarker || !commandValue) {
    return null;
  }
  return {
    version: 1,
    platform: process.platform,
    bootMarker,
    startMarker,
    commandHash: digest(commandValue)
  };
}

export function validProcessIdentity(identity) {
  return Boolean(
    identity &&
      typeof identity === "object" &&
      !Array.isArray(identity) &&
      identity.version === 1 &&
      typeof identity.platform === "string" &&
      identity.platform.length > 0 &&
      typeof identity.bootMarker === "string" &&
      identity.bootMarker.length > 0 &&
      typeof identity.startMarker === "string" &&
      identity.startMarker.length > 0 &&
      typeof identity.commandHash === "string" &&
      identity.commandHash.length > 0
  );
}

export function getProcessIdentity(pid) {
  if (!directProcessAlive(pid)) {
    return null;
  }
  if (pid === process.pid && cachedOwnIdentity) {
    return cachedOwnIdentity;
  }
  let identity;
  if (process.platform === "linux") {
    identity = linuxProcessIdentity(pid);
  } else if (process.platform === "darwin" || process.platform === "freebsd" || process.platform === "openbsd") {
    identity = bsdProcessIdentity(pid);
  }
  if (pid === process.pid && identity) {
    cachedOwnIdentity = identity;
  }
  return identity ?? null;
}

export function processIdentitiesMatch(currentIdentity, expectedIdentity) {
  return validProcessIdentity(currentIdentity) && validProcessIdentity(expectedIdentity) && currentIdentity.version === expectedIdentity.version && currentIdentity.platform === expectedIdentity.platform && currentIdentity.bootMarker === expectedIdentity.bootMarker && currentIdentity.startMarker === expectedIdentity.startMarker && currentIdentity.commandHash === expectedIdentity.commandHash;
}

export function processIdentityMatches(pid, expectedIdentity) {
  return processIdentitiesMatch(getProcessIdentity(pid), expectedIdentity);
}

export function processIsDirectlyAlive(pid) {
  return directProcessAlive(pid);
}
