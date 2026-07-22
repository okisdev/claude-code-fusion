function renderCell(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    throw new TypeError("cells must be strings, numbers, booleans, null, or undefined");
  }
  const rendered = String(value);
  if (/\r|\n/.test(rendered)) {
    throw new RangeError("cells must be single line");
  }
  return rendered;
}

function validateTable(headers, rows) {
  if (!Array.isArray(headers) || headers.length === 0 || headers.some((header) => typeof header !== "string")) {
    throw new TypeError("headers must be a nonempty array of strings");
  }
  if (headers.some((header) => /\r|\n/.test(header))) {
    throw new RangeError("headers must be single line");
  }
  if (!Array.isArray(rows)) {
    throw new TypeError("rows must be an array");
  }
  const renderedRows = rows.map((row) => {
    if (!Array.isArray(row) || row.length !== headers.length) {
      throw new TypeError("each row must match the header count");
    }
    return row.map(renderCell);
  });
  return { headers, renderedRows };
}

export function measureTable(headers, rows) {
  const table = validateTable(headers, rows);
  return table.headers.map((header, index) => Math.max(header.length, ...table.renderedRows.map((row) => row[index].length)));
}

export function formatTable(headers, rows) {
  const table = validateTable(headers, rows);
  const widths = measureTable(headers, rows);
  const separator = `+${widths.map((width) => "-".repeat(width + 2)).join("+")}+`;
  const formatRow = (cells) => `| ${cells.map((cell, index) => cell.padEnd(widths[index])).join(" | ")} |`;
  return [separator, formatRow(table.headers), separator, ...table.renderedRows.map(formatRow), separator].join("\n");
}
