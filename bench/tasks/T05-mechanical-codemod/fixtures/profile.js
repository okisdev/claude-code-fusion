import { formatWithCallback } from "./format.js";

export function buildProfile(name) {
  return new Promise((resolve) => {
    formatWithCallback(name, (value) => {
      resolve(`Profile: ${value}`);
    });
  });
}
