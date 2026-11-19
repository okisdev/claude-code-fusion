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
} = createCompanionRender({ engine: "agy", engineName: "Antigravity", resolvedEffortField: "resolvedEffort", stopCauseField: "stopReason" });

export function renderSetupReport(report) {
  const agy = report.agy ?? {};
  const lines = [
    "# Antigravity setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- agy binary (${agy.buildPath ?? agy.bin ?? "agy"}): ${agy.available ? agy.detail : `unavailable, ${agy.detail ?? "not checked"}`}`,
    `- version: ${agy.version ?? "unknown"}`,
    `- compatibility: ${report.compatibility ?? "unknown"}${report.testedInterval ? ` (${report.testedInterval.floor} to before ${report.testedInterval.ceiling})` : ""}`,
    `- authentication: ${report.auth?.authenticated ? "authenticated" : report.auth?.detail ?? "not checked"}`,
    `- catalog: ${report.catalog?.detail ?? (Number.isInteger(report.catalogSize) ? `${report.catalogSize} Google models` : "not checked")}`,
    `- Google models: ${report.models?.map((model) => model.id).join(", ") || "none available"}`,
    `- project configuration: ${report.projectConfigFiles?.length ? report.projectConfigFiles.join(", ") : "none detected"}`,
    `- data dir: ${report.dataDir?.writable ? `writable (${report.dataDir.path})` : `not writable (${report.dataDir?.detail ?? "not checked"})`}`
  ];
  for (const step of report.nextSteps ?? []) {
    lines.push(`- ${step}`);
  }
  for (const warning of report.projectConfigWarnings ?? []) lines.push(`warning: ${warning}`);
  return `${lines.join("\n").trimEnd()}\n`;
}
