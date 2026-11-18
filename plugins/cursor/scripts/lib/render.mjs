import { createCompanionRender } from "./companion-render.mjs";

export { extractFirstJsonObject, validateReviewOutput, formatAge, renderReviewResult } from "./companion-render.mjs";

export const {
  renderHistoryReport,
  renderTaskResult,
  renderBackgroundLaunch,
  renderStatusTable,
  renderJobDetail,
  renderCancelReport,
  renderRecordAcceptance
} = createCompanionRender({ engine: "cursor", engineName: "Cursor" });

export function renderSetupReport(report) {
  const cursor = report.cursor ?? {};
  const lines = [
    "# Cursor setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- cursor-agent binary (${cursor.bin ?? "cursor-agent"}): ${cursor.available ? cursor.detail : `unavailable, ${cursor.detail ?? "not checked"}`}`,
    `- compatibility: ${report.compatibility ?? "unknown"}`,
    `- data dir: ${report.dataDir?.writable ? `writable (${report.dataDir.path})` : `not writable (${report.dataDir?.detail ?? "not checked"})`}`
  ];
  for (const step of report.nextSteps ?? []) {
    lines.push(`- ${step}`);
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
