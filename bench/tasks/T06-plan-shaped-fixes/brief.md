# Three independent fixes

This folder contains three separate Node ESM packages. They share no files, imports, or state, so the work packages below can be fixed in any order or in parallel. Keep each package's public API unchanged.

## Work package 1: CSV parser

In `csv-parser/index.js`, `parseCsvLine` must treat a comma inside double quotes as part of the current field. Reproduce the defect from `fixtures/` with:

```sh
node --input-type=module -e 'import { parseCsvLine } from "./csv-parser/index.js"; console.log(parseCsvLine("team,\"Park, Mina\""));'
```

The result should contain two fields, `team` and `Park, Mina`. The current implementation incorrectly returns three fields because it splits the quoted comma.

## Work package 2: Duration formatter

In `duration-formatter/index.js`, `formatDuration` must use completed minutes and the remaining seconds. Reproduce the defect from `fixtures/` with:

```sh
node --input-type=module -e 'import { formatDuration } from "./duration-formatter/index.js"; console.log(formatDuration(90));'
```

The result should be `1m 30s`. The current implementation rounds the minute count up and returns `2m -30s`.

## Work package 3: Path matcher

In `path-matcher/index.js`, `matchesPath` supports `*` as a wildcard within one path segment. Reproduce the defect from `fixtures/` with:

```sh
node --input-type=module -e 'import { matchesPath } from "./path-matcher/index.js"; console.log(matchesPath("src/*.js", "src/nested/main.js"));'
```

The result should be `false`. The current implementation lets `*` cross a path separator, so it incorrectly returns `true`.
