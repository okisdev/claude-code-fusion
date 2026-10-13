The library in this workspace is a numeric range helper exported from range.js. Its documented behavior:

- `clamp(value, min, max)` throws a RangeError when min is greater than max, returns min when value is below min, returns max when value is above max, and otherwise returns value unchanged.
- `normalize(value, min, max)` throws a RangeError when max equals min, and otherwise maps the clamped value onto the 0 to 1 interval, so a value at min maps to 0 and a value at max maps to 1.
- `lerp(t, min, max)` returns the point a fraction t of the way from min to max, without clamping t.

Review range.js for correctness defects against this documented behavior. This is a read only consult: do not edit or create any file. Report every defect you can demonstrate, each with its file and line, a concrete call, the expected and actual results, and the minimal fix. Do not report style preferences or behavior the documentation leaves open. If you find no defect, say so. Keep the report under 40 lines.
