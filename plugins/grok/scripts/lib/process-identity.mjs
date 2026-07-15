import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";

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
  let bootId;
  let command;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    command = fs.readFileSync(`/proc/${pid}/cmdline`);
  } catch {
    return null;
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
  const boot = process.platform === "darwin"
    ? spawnSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8", env, timeout: 2000, windowsHide: true })
    : spawnSync("uptime", ["-s"], { encoding: "utf8", env, timeout: 2000, windowsHide: true });
  const startMarker = String(started.stdout ?? "").trim().replace(/\s+/g, " ");
  const commandValue = String(command.stdout ?? "").trim();
  const bootValue = String(boot.stdout ?? "").trim();
  if (started.status !== 0 || command.status !== 0 || boot.status !== 0 || !startMarker || !commandValue || !bootValue) {
    return null;
  }
  const darwinBoot = process.platform === "darwin" ? bootValue.match(/\bsec\s*=\s*(\d+)\s*,\s*usec\s*=\s*(\d+)\b/) : null;
  return {
    version: 1,
    platform: process.platform,
    bootMarker: darwinBoot ? `${darwinBoot[1]}.${darwinBoot[2]}` : digest(bootValue),
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
  if (process.platform === "linux") {
    return linuxProcessIdentity(pid);
  }
  if (process.platform === "darwin" || process.platform === "freebsd" || process.platform === "openbsd") {
    return bsdProcessIdentity(pid);
  }
  return null;
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
