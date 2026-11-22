export function renderFooterLines(record, engine, detailLines = []) {
  const lines = [];
  if (record.sessionId) {
    lines.push(`${engine}-session: ${record.sessionId}`);
  }
  if (record.id) {
    if (typeof record.cwd !== "string" || !record.cwd) {
      throw new TypeError("A job footer requires a workspace path.");
    }
    lines.push(`job: ${record.id}`);
    if (record.resumedFromJobId) {
      lines.push(`resumed-from: ${record.resumedFromJobId}`);
    }
    lines.push(`sandbox: ${record.cwd}`);
  }
  if (record.delivery) {
    lines.push(`delivery: ${record.delivery}`);
  }
  if (record.semanticStatus) {
    lines.push(`semantic: ${record.semanticStatus}`);
  }
  lines.push(...detailLines);
  for (const warning of record.warnings ?? []) {
    lines.push(`warning: ${String(warning).replace(/[\r\n]+/g, " ")}`);
  }
  lines.push(`state: ${record.status ?? "done"}`);
  if (record.status === "cancelled" || record.status === "error") {
    lines.push(`failure: ${record.failureKind ?? (record.status === "cancelled" ? "cancelled" : "error")}`);
  }
  return lines;
}

export function renderFailure(message, failureKind, json = false) {
  return json ? `${JSON.stringify({ status: "error", failureKind, message }, null, 2)}\n`
    : `${message}\n${renderFooterLines({ status: "error", failureKind }).join("\n")}\n`;
}
