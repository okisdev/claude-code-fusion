import { formatWithCallback } from "./format.js";

export function buildGreeting(name) {
  return new Promise((resolve) => {
    formatWithCallback(name, (value) => {
      resolve(`Hello, ${value}!`);
    });
  });
}
