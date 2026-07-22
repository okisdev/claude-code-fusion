import { format } from "./format.js";

export async function buildReminder(task) {
  const value = await format(task);
  return `Reminder: ${value}`;
}
