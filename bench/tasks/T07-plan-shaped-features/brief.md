# Plan shaped feature packages

This project contains three independent feature packages. Each package owns one module and has no shared files, imports, or state with the other packages. You can implement the packages in any order or in parallel. Use only named exports. Do not add default exports.

## Package 1: Query string codec

Implement `parseQuery(input)` and `stringifyQuery(values)` in `query-string/index.js`.

`parseQuery` accepts a string and returns a null prototype record. A leading `?` is optional. Ignore everything from the first `#` onward. Split the remaining text on `&`, ignoring empty segments. Split each nonempty segment at its first `=`. A segment without `=` has an empty value. Replace `+` with a space before percent decoding keys and values with `decodeURIComponent`. Keep an empty key when it occurs. A repeated key holds an array of decoded string values in encounter order. A key seen once holds its decoded string value. Nonstring input throws `TypeError`, and malformed percent escapes keep the `URIError` from `decodeURIComponent`.

`stringifyQuery` accepts a nonnull object that is not an array. Process its own enumerable keys in `Object.keys` order. A scalar produces one `key=value` pair. An array produces one pair per item in array order. Skip `undefined` values, including `undefined` array items. Render `null` as an empty value. Render every other value with `String`. Percent encode keys and values with `encodeURIComponent`, then replace `%20` with `+`. Always include `=` in emitted pairs. Join pairs with `&`. The function must not mutate its input. Invalid input throws `TypeError`.

## Package 2: Semantic version ranges

Implement `parseVersion(input)`, `compareVersions(left, right)`, and `satisfiesRange(version, range)` in `semver-range/index.js`.

`parseVersion` accepts only a string in the exact stable form `MAJOR.MINOR.PATCH`. Each component is a nonnegative safe integer with no leading zero unless it is `0`. It returns an object with numeric `major`, `minor`, and `patch` properties. Nonstring input throws `TypeError`. Invalid version text throws `RangeError`.

`compareVersions` accepts two valid version strings and returns `-1`, `0`, or `1` according to semantic version ordering by major, minor, then patch.

`satisfiesRange` accepts a valid version string and a range string. A range may be `*`, an exact version such as `1.2.3`, or one or more whitespace separated comparators that are all required to match. Comparators use `>`, `>=`, `<`, `<=`, or optional `=` followed immediately by an exact version. It also supports `^MAJOR.MINOR.PATCH` and `~MAJOR.MINOR.PATCH`. A caret range includes its lower bound and excludes the next major for a positive major, the next minor for `0` major and positive minor, or the next patch for `0.0` versions. A tilde range includes its lower bound and excludes the next minor version. Leading and trailing range whitespace is ignored. Empty, malformed, or unsupported ranges throw `RangeError`. A nonstring range throws `TypeError`.

## Package 3: Text table renderer

Implement `measureTable(headers, rows)` and `formatTable(headers, rows)` in `text-table/index.js`.

`headers` must be a nonempty array of strings. `rows` must be an array of arrays, and every row must contain exactly one cell for each header. A cell may be a string, number, boolean, `null`, or `undefined`. Render `null` and `undefined` as an empty string and render other cell values with `String`. Reject any header or rendered cell containing `\r` or `\n` with `RangeError`. Reject invalid argument shapes or unsupported cell types with `TypeError`.

`measureTable` returns a new array of column widths. Each width is the greatest JavaScript string length of its header and rendered cells. It must not mutate either argument.

`formatTable` uses those widths to return an ASCII table with a top separator, a header row, a separator, every data row, and a final separator. A separator uses `+`, then `-` repeated for the column width plus two, for every column, and a final `+`. A row uses `| `, the left aligned cell padded with spaces to the column width, ` |` for every column, and no trailing whitespace after the final `|`. Separate lines with `\n` and do not append a final newline. Empty `rows` still produces the top separator, header row, middle separator, and final separator.
