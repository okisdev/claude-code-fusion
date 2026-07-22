import { formatWithCallback } from "./format.js";

export function buildSummary(topic) {
  return new Promise((resolve) => {
    formatWithCallback(topic, (value) => {
      resolve(`Summary: ${value}`);
    });
  });
}
