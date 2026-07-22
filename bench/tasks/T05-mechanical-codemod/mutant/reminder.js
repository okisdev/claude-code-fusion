import { formatWithCallback } from "./format.js";

export function buildReminder(task) {
  return new Promise((resolve) => {
    formatWithCallback(task, (value) => {
      resolve(`Reminder: ${value}`);
    });
  });
}
