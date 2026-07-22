export function parseCsvLine(line) {
  return line.split(",").map((field) => field.trim());
}
