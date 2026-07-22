import { formatWithCallback } from "./format.js";

export function buildStatus(status) {
  return new Promise((resolve) => {
    formatWithCallback(status, (value) => {
      resolve(`Status: ${value.toUpperCase()}`);
    });
  });
}
