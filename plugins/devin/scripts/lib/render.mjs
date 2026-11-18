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
} = createCompanionRender({ engine: "devin", engineName: "Devin", resolvedEffortField: "resolvedEffort", stopCauseField: "stopCause" });

export function renderSetupReport(report) {
  const devin = report.devin ?? {};
  const lines = [
    "# Devin setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- devin binary (${devin.buildPath ?? devin.bin ?? "devin"}): ${devin.available ? devin.detail : `unavailable, ${devin.detail ?? "not checked"}`}`,
    `- version: ${devin.version ?? "unknown"}`,
    `- compatibility: ${report.compatibility ?? "unknown"}`,
    `- authentication: ${report.auth?.authenticated ? "authenticated" : report.auth?.detail ?? "not checked"}`,
    `- plan tier: ${report.planTier ?? report.auth?.planTier ?? "unknown"}`,
    `- catalog: ${report.catalog?.detail ?? (Number.isInteger(report.catalogSize) ? `${report.catalogSize} families` : "not checked")}`,
    `- project configuration: ${report.projectConfigFiles?.length ? report.projectConfigFiles.join(", ") : "none detected"}`,
    `- data dir: ${report.dataDir?.writable ? `writable (${report.dataDir.path})` : `not writable (${report.dataDir?.detail ?? "not checked"})`}`
  ];
  for (const step of report.nextSteps ?? []) {
    lines.push(`- ${step}`);
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
