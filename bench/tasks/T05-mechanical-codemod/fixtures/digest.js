import { formatWithCallback } from "./format.js";

export function buildDigest(period) {
  return new Promise((resolve) => {
    formatWithCallback(period, (value) => {
      resolve(`Digest: ${value.toLowerCase()}`);
    });
  });
}
