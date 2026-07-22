import { formatWithCallback } from "./format.js";

export function buildReceipt(order) {
  return new Promise((resolve) => {
    formatWithCallback(order, (value) => {
      resolve(`Receipt: ${value}`);
    });
  });
}
