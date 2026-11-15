export { parseArgs, parseRawArgs, splitRawArgumentString } from "./shared-args.mjs";

const SERVICE_TIER_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export function parseServiceTier(value) {
  if (value == null) {
    return "priority";
  }
  if (value === "none") {
    return null;
  }
  if (typeof value !== "string" || !SERVICE_TIER_PATTERN.test(value)) {
    throw new TypeError("The --service-tier option must be a lowercase id or none.");
  }
  return value;
}
