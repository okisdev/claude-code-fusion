import { formatWithCallback } from "./format.js";

export function buildAlert(message) {
  return new Promise((resolve) => {
    formatWithCallback(message, (value) => {
      resolve(`Alert: ${value.toUpperCase()}`);
    });
  });
}
