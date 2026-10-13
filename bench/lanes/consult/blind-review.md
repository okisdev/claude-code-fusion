This workspace holds three independent Node ESM packages. Their documented behavior:

- `csv-parser/index.js` exports `parseCsvLine(line)`, which splits one CSV line into fields. Fields are separated by commas, a field wrapped in double quotes may contain commas, a doubled double quote inside a quoted field stands for one literal double quote, and surrounding whitespace is trimmed from each field.
- `duration-formatter/index.js` exports `formatDuration(totalSeconds)`, which truncates its input to whole seconds, treats negative input as 0, and formats the result as `<minutes>m <seconds>s` using completed minutes and the remaining seconds, or as `<seconds>s` under one minute.
- `path-matcher/index.js` exports `matchesPath(pattern, candidate)`, which matches a slash separated path against a pattern in which `*` matches any run of characters within a single path segment and every other character matches itself literally.

Review the three packages for correctness defects against this documented behavior. This is a read only consult: do not edit or create any file. Report every defect you can demonstrate, each with its file and line, a concrete call, the expected and actual results, and the minimal fix. Do not report style preferences or behavior the documentation leaves open. If a package has no defect, say so. Keep the report under 80 lines.
