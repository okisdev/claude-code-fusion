import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isReadOnlyCommand } from "../plugins/agy/scripts/lib/agy-command-check.mjs";
import { git, initCleanRepo } from "./lib/git-fixture.mjs";

for (const command of ["ls -la", "pwd", "cat README.md", "head -n 20 README.md", "tail -n 10 log.txt", "wc -l README.md", "stat README.md", "grep -n TODO src", "rg --files", "rg -n 'two words' src", 'cat "a file.txt"', "find . -name '*.mjs'", "find . -type f -print", "git status --short", "git log --oneline -5", "git show --stat", "git diff --cached --stat", "git ls-files --cached", "git grep --cached", "git rev-parse --show-toplevel", "git branch", "git branch --list -a -r -v", "git status path", "git log main", "git show HEAD", "git diff HEAD", "git ls-files src", "git grep pattern", "git blame file", "git rev-parse HEAD", "git branch --show-current", "git branch -av", "  pwd\t ",
  'rg -n "kSecAttrAccessGroup|appGroupIdentifier|keychain-access-groups" apps/apple',
  'rg "next/|use client|server-only|:\\s*any\\b|as any\\b" apps/web/routes/auth',
  "find . \\( -name a -o -name b \\) -type f"
]) {
  test(`accepts ${command}`, () => assert.equal(isReadOnlyCommand(command), true));
}
for (const metacharacter of ["\n", "\r", "\0"]) {
  test(`refuses control character ${JSON.stringify(metacharacter)} anywhere`, () => {
    for (const command of [`cat a${metacharacter}b`, `cat 'a${metacharacter}b'`, `cat "a${metacharacter}b"`, `cat a\\${metacharacter}b`]) assert.equal(isReadOnlyCommand(command), false);
  });
}
for (const metacharacter of [";", "|", "&", ">", "<"]) {
  test(`refuses unquoted metacharacter ${metacharacter}`, () => {
    assert.equal(isReadOnlyCommand(`cat a${metacharacter}b`), false);
    assert.equal(isReadOnlyCommand(`cat 'a${metacharacter}b'`), true);
    assert.equal(isReadOnlyCommand(`cat "a${metacharacter}b"`), true);
    assert.equal(isReadOnlyCommand(`cat a\\${metacharacter}b`), true);
  });
}
test("accepts one trailing stderr redirect to /dev/null", () => {
  for (const command of ["ls -la", "pwd", "cat file", "head file", "tail file", "wc file", "stat file", "grep needle file", "rg needle file", "git status --short", 'find . -name "*USB*.h"']) {
    assert.equal(isReadOnlyCommand(`${command}\t2>/dev/null \t`), true, command);
  }
});
test("rejects other redirects and checks commands before the stderr redirect", () => {
  for (const command of [
    "cat file 2>/tmp/x", "cat file > out", "cat file >/dev/null", "cat file 1>/dev/null", "cat file 2>>/dev/null", "cat file 2> /dev/null",
    "cat file 2>/dev/null extra", "cat file 2>/dev/null 2>/dev/null", "cat file 2>/dev/null\n", "cat file2>/dev/null", "cat file\\ 2>/dev/null",
    'cat file "2">/dev/null', "cat file 2>/dev/null; pwd", "2>/dev/null", "rm file 2>/dev/null", "find . -name 2>/dev/null", "find . -delete 2>/dev/null"
  ]) assert.equal(isReadOnlyCommand(command), false, JSON.stringify(command));
});
for (const metacharacter of ["$", "`"]) {
  test(`refuses expansion character ${JSON.stringify(metacharacter)}`, () => {
    assert.equal(isReadOnlyCommand(`cat a${metacharacter}b`), false);
    assert.equal(isReadOnlyCommand(`cat 'a${metacharacter}b'`), true);
    assert.equal(isReadOnlyCommand(`cat "a${metacharacter}b"`), false);
    assert.equal(isReadOnlyCommand(`cat a\\${metacharacter}b`), true);
    assert.equal(isReadOnlyCommand(`cat "a\\${metacharacter}b"`), true);
  });
}
test("refuses unquoted expansion syntax", () => {
  for (const command of ["cat $(x)", "cat ${x}", "cat `x`", "cat a\\", "cat \"a\\"]) assert.equal(isReadOnlyCommand(command), false);
});
test("accepts literal backslash escapes", () => {
  for (const command of ["cat a\\b", "cat a\\ b", "cat \\~x", 'cat "a\\b"', 'cat "a\\xb"']) assert.equal(isReadOnlyCommand(command), true);
});
for (const flag of ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]) {
  test(`refuses find ${flag}`, () => {
    for (const spelling of [flag, `'${flag}'`, `"${flag}"`, flag.slice(0, 2) + "''" + flag.slice(2)]) assert.equal(isReadOnlyCommand(`find . ${spelling} target`), false);
  });
}
for (const command of ["git", "git checkout", "git switch", "git commit", "git reset", "git clean", "git config", "git push", "git fetch", "git worktree", "git update-ref", "git -c alias.x=status x", "git branch new", "git branch -D main", "git branch --delete main", "git branch --move", "git branch --list=main", "git branch --output=file"]) {
  test(`refuses ${command}`, () => assert.equal(isReadOnlyCommand(command), false));
}
for (const subcommand of ["status", "log", "show", "diff", "ls-files", "grep", "blame", "rev-parse"]) {
  test(`refuses git ${subcommand} output flags`, () => {
    for (const flag of ["--output", "--output=x", "--output-indicator-new=x", "'--output=x'"]) assert.equal(isReadOnlyCommand(`git ${subcommand} ${flag}`), false);
  });
}
for (const command of ["file image.png", "tree -L 2", "git blame --help", "rg --pre cat pattern", "rg --pre=cat pattern", "rg '--pre=cat' pattern", "rg --pre''=cat pattern", "", " ", "cat 'unterminated", 'cat "unterminated', "'ls -la'", "/bin/ls", "env ls", "sh -c ls", "echo hi", "touch x", "rm x", "npm test", "python -c pass"]) {
  test(`refuses command ${JSON.stringify(command)}`, () => assert.equal(isReadOnlyCommand(command), false));
}
test("refuses absent and non string commands", () => {
  for (const value of [undefined, null, {}, [], 1, true]) assert.equal(isReadOnlyCommand(value), false);
});

for (const command of [
  "find . $'-exec' /bin/sh -c x {} +", "find . '-exec' sh {} ;", 'find . "-delete"',
  "rg $'--pre=/bin/sh' x .", "rg --pre=sh x", "rg -z x a.gz", "rg -nz x", "rg --search-zip x", "rg --hostname-bin=sh x",
  "git grep --open-files-in-pager=/bin/sh -efoo", "git grep -O sh foo", "git -c core.pager=sh log", "git log --output=x", "git diff --ext-diff",
  "file -C -m m", "tree -o x .", "/bin/ls", "FOO=1 ls", "tail -f x", "ls *", "cat ~/.ssh/config", 'cat "unterminated'
]) {
  test(`rejects security finding ${JSON.stringify(command)}`, () => assert.equal(isReadOnlyCommand(command), false));
}

for (const command of [
  'rg -n "foo(bar" src', "grep -rn 'x y' .", "git log --oneline -n 20", "git diff --stat HEAD~1", 'find . -name "*.mjs" -type f',
  "r'g' -n 'two 'words src", '"r"g -ni "foo"bar src', "cat '' \"\"", "'ls' -la", "cat foo~bar foo#bar a=b a!b",
  "rg -n -- '--pre=sh'", "rg -e --pre=sh .", "rg --regexp --pre=sh .", "rg --regexp=--pre=sh .", "tail -- -f",
  "git log -- --output=x", "git branch --list 'topic*'", "git branch --list -- --delete", "git status -sb", "git log -pn 20", "git grep -nwe foo",
  "find . '(' -name '*.mjs' -o -name '*.js' ')' '!' -empty -print"
]) {
  test(`accepts parsed command ${JSON.stringify(command)}`, () => assert.equal(isReadOnlyCommand(command), true));
}

for (const character of "{}()") {
  test(`rejects unquoted shell syntax ${character}`, () => {
    for (const argument of [character, `a${character}b`, `'a'${character}`]) assert.equal(isReadOnlyCommand(`cat ${argument}`), false);
    for (const quote of ["'", '"']) assert.equal(isReadOnlyCommand(`cat ${quote}a${character}b${quote}`), true);
    assert.equal(isReadOnlyCommand(`cat a\\${character}b`), true);
  });
}
for (const character of "*?[]") {
  test(`checks unquoted glob syntax ${character}`, () => {
    for (const argument of [character, `${character}x`, `-${character}x`, `'${character}'x${character}`]) assert.equal(isReadOnlyCommand(`cat ${argument}`), false);
    for (const argument of [`a${character}b`, `'a'${character}b`, `a\\${character}b`, `\\${character}b`]) assert.equal(isReadOnlyCommand(`cat ${argument}`), true);
    for (const quote of ["'", '"']) assert.equal(isReadOnlyCommand(`cat ${quote}a${character}b${quote}`), true);
  });
}

for (const character of "~#!=") {
  test(`rejects unquoted token prefix ${character}`, () => {
    assert.equal(isReadOnlyCommand(`cat ${character}x`), false);
    assert.equal(isReadOnlyCommand(`cat 'x${character}'`), true);
    assert.equal(isReadOnlyCommand(`cat '${character}x'`), true);
    assert.equal(isReadOnlyCommand(`cat x${character}`), true);
  });
}

for (const command of [
  '"/bin/ls"', "F'O'O=1 ls", "ls=foo", "tail -F x", "tail --follow x", "tail --follow=name x", "tail -nf x", "tail '-nF' x", "tail -'f' x",
  "rg --pre-glob '*.mjs' x", "rg --pre''=sh x", "rg --search-zi x", "rg --unknown x", "rg -nZ x", "rg --hidden=true x", "rg -niZ x", "rg --regexp=",
  "find -L . -print", "find . -L", "find . -follow -print", "find . -unknown", "find . -print -delete", "find . -print unexpected", "find . -name", "find . ( -print )", "find . ! -empty",
  "git --git-dir=.git log", "git --exec-path=bin log", "git status --unknown", "git status -suZ", "git log -np 20", "git log --oneline=true",
  "git branch -avD main", "git branch -- --list new", "git branch --list=topic", "git branch --all new", "git diff --textconv", "git grep '-nO' sh foo",
  "git log --format --output=x", "git log --pretty --output=x", "git diff -U --output=x", "git diff --unified --output=x", "git show --format --output=x"
]) {
  test(`rejects parsed command ${JSON.stringify(command)}`, () => assert.equal(isReadOnlyCommand(command), false));
}

test("git -C checks each directory relative to the previous one", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-git-cwd-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = fs.mkdirSync(path.join(root, "repo"), { recursive: true });
  git(cwd, ["init", "-q"]);
  const realHome = path.join(cwd, "home");
  const sensitive = path.join(realHome, ".ssh", "inner");
  fs.mkdirSync(sensitive, { recursive: true });
  fs.mkdirSync(path.join(cwd, "a repo", "child"), { recursive: true });
  fs.symlinkSync(sensitive, path.join(cwd, "linked"));
  fs.writeFileSync(path.join(cwd, "file"), "");
  const options = { cwd, realHome };
  for (const args of ["-C . status", `-C '${cwd}/a repo' show ed1f54c`, "-C 'a repo' diff c943403..HEAD", "-C . -C 'a repo' -C child log"]) {
    assert.equal(isReadOnlyCommand(`git ${args}`, options), true, args);
  }
  for (const args of ["-C", "-C '' log", "-C missing log", `-C missing -C '${cwd}' log`, "-C file log", "-C home/.ssh log", "-C linked log", "-C linked/.. log",
    "-C 'a repo' -C ../home/.ssh log", "-C a* log", "-C . -c alias.x=status x", "-C . --git-dir=.git log", "-C . fetch", "-C . diff --output=file"]) {
    assert.equal(isReadOnlyCommand(`git ${args}`, options), false, args);
  }
});

test("git -C accepts linked worktrees and refuses unrelated repositories", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-external-repo-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = fs.mkdirSync(path.join(root, "repo"), { recursive: true });
  const linked = path.join(root, "linked");
  const unrelated = fs.mkdirSync(path.join(root, "unrelated"), { recursive: true });
  const nested = fs.mkdirSync(path.join(cwd, "nested"), { recursive: true });
  const bare = fs.mkdirSync(path.join(cwd, "bare.git"), { recursive: true });
  initCleanRepo(cwd);
  git(cwd, ["worktree", "add", "-q", "--detach", linked]);
  git(unrelated, ["init", "-q"]);
  git(nested, ["init", "-q"]);
  git(bare, ["init", "-q", "--bare"]);

  assert.equal(isReadOnlyCommand(`git -C '${linked}' status --short`, { cwd }), true);
  assert.equal(isReadOnlyCommand(`git -C '${cwd}' status --short`, { cwd: linked }), true);
  assert.equal(isReadOnlyCommand(`git -C '${linked}' status --unknown`, { cwd }), false);
  for (const directory of [unrelated, nested, bare, root]) {
    assert.equal(isReadOnlyCommand(`git -C '${directory}' status --short`, { cwd }), false);
    assert.equal(isReadOnlyCommand(`git -C '${directory}' -C '${linked}' status --short`, { cwd }), false);
  }
  assert.equal(isReadOnlyCommand(`git -C '${linked}' status --short`, { cwd: root }), false);
});

test("git -C refuses invalid workspace and target repository metadata", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-invalid-git-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = fs.mkdirSync(path.join(root, "workspace"), { recursive: true });
  const sub = fs.mkdirSync(path.join(cwd, "sub", ".git"), { recursive: true });
  const external = fs.mkdirSync(path.join(root, "external"), { recursive: true });
  initCleanRepo(external);
  fs.writeFileSync(path.join(sub, "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(sub, "commondir"), `${path.join(external, ".git")}\n`);

  assert.equal(isReadOnlyCommand("git -C sub status", { cwd }), false);
  fs.writeFileSync(path.join(cwd, ".git"), "invalid git file\n");
  assert.equal(isReadOnlyCommand("git -C . status", { cwd }), false);
});

test("git -C accepts submodules inside the workspace", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-git-submodule-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = fs.mkdirSync(path.join(root, "repo"), { recursive: true });
  const origin = fs.mkdirSync(path.join(root, "origin"), { recursive: true });
  initCleanRepo(cwd);
  initCleanRepo(origin);
  git(cwd, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", origin, "module"]);
  const sibling = fs.mkdirSync(path.join(cwd, "sibling"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "module", "nested"));

  assert.equal(isReadOnlyCommand("git -C module -C nested status", { cwd }), true);
  assert.equal(isReadOnlyCommand("git -C ../module status", { cwd: sibling }), false);
});

test("git -C walks past directories with incomplete bare repository metadata", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agy-git-lookalike-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  initCleanRepo(cwd);
  fs.mkdirSync(path.join(cwd, "nested", "objects"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "nested", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(cwd, "nested", "refs"), "");
  assert.equal(isReadOnlyCommand("git -C nested status", { cwd }), true);

  fs.writeFileSync(path.join(cwd, "nested", "commondir"), "missing\n");
  assert.equal(isReadOnlyCommand("git -C nested status", { cwd }), true);
});

test("git -C accepts ..metadata inside a workspace without a repository", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-git-no-repo-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "workspace");
  fs.mkdirSync(path.join(cwd, "..metadata"), { recursive: true });
  fs.mkdirSync(path.join(root, "..metadata"));

  assert.equal(isReadOnlyCommand("git -C ..metadata status", { cwd }), true);
  assert.equal(isReadOnlyCommand("git -C ../..metadata status", { cwd }), false);
});

test("git pathspec globs keep command and option checks", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agy-git-pathspec-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  for (const command of ["git ls-files *MessageGroupedParts*", "git grep needle ?file", "git grep -ne needle *file", "git log -- [ab]file", "git diff HEAD *file", "git show HEAD -- *file"]) {
    assert.equal(isReadOnlyCommand(command, { cwd }), true, command);
  }
  for (const command of ["git status *file", "git blame *file", "git branch --list *file", "git log --grep *file", "git grep -ne *file", "git grep *file", "git show --output=file *file", "git ls-files *file; touch file"]) {
    assert.equal(isReadOnlyCommand(command, { cwd }), false, command);
  }
  fs.writeFileSync(path.join(cwd, "-file"), "");
  assert.equal(isReadOnlyCommand("git diff *file", { cwd }), false);
  assert.equal(isReadOnlyCommand("git diff -- *file", { cwd }), true);
});

for (const flag of "--hidden --no-ignore --files --files-with-matches --count --line-number --no-line-number --ignore-case --smart-case --case-sensitive --fixed-strings --word-regexp --invert-match --multiline --json --follow --with-filename --no-heading --heading --null --only-matching --text".split(" ")) {
  test(`accepts rg boolean flag ${flag}`, () => {
    assert.equal(isReadOnlyCommand(`rg '${flag}' needle src`), true);
    assert.equal(isReadOnlyCommand(`rg ${flag}=true needle src`), false);
  });
}

for (const flag of "--max-count --glob --iglob --type --type-not --context --before-context --after-context --max-depth --sort --regexp".split(" ")) {
  test(`checks rg value flag ${flag}`, () => {
    assert.equal(isReadOnlyCommand(`rg ${flag} value needle src`), true);
    assert.equal(isReadOnlyCommand(`rg '${flag}=value' needle src`), true);
    assert.equal(isReadOnlyCommand(`rg ${flag}`), false);
  });
}

for (const flag of "niSsFwvlcULHNouxa") {
  test(`accepts rg short flag ${flag} in a cluster`, () => assert.equal(isReadOnlyCommand(`rg -n${flag} needle src`), true));
}

for (const flag of "egtTABCmM") {
  test(`checks rg short value flag ${flag}`, () => {
    for (const argument of [`-${flag}value`, `-n${flag}value`, `-${flag} value`, `-${flag}=value`]) assert.equal(isReadOnlyCommand(`rg ${argument} needle src`), true);
    assert.equal(isReadOnlyCommand(`rg -${flag}`), false);
  });
}

test("rg and grep allow text searches for binary input", () => {
  for (const program of ["rg", "grep"]) {
    for (const flag of ["-a", "--text"]) {
      const command = `${program} ${flag} -n "\\x00" file.ts`;
      assert.equal(isReadOnlyCommand(command), true, command);
      assert.equal(isReadOnlyCommand(`${command} 2>/tmp/x`), false, command);
    }
  }
});

test("find permits tilde expansion for readable starting paths under the real home", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agy-find-home-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const realHome = path.join(directory, "home");
  const outside = path.join(directory, "home-other");
  const sensitive = path.join(realHome, ".ssh");
  for (const target of [outside, sensitive, path.join(realHome, ".nvm"), path.join(realHome, "a folder")]) fs.mkdirSync(target, { recursive: true });
  fs.symlinkSync(outside, path.join(realHome, "external"));
  fs.symlinkSync(sensitive, path.join(realHome, "private"));
  for (const command of [`find '${outside}' ~/.nvm -maxdepth 6 -name "exec.js" 2>/dev/null`, "find -H ~/'a folder' -print"]) {
    assert.equal(isReadOnlyCommand(command, { realHome }), true, command);
  }
  for (const command of [
    "find ~ -print", "find ~other/.nvm -print", "find ~/.ssh -print", "find ~/private -print", "find ~/external -print", "find ~/../home-other -print",
    "find ~/missing -print", "find ~/.n* -print", "find . -name ~/.nvm", "cat ~/.nvm"
  ]) assert.equal(isReadOnlyCommand(command, { realHome }), false, command);
});

test("find validates every starting path against sensitive home directories", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agy-find-start-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const realHome = path.join(directory, "home");
  const cwd = path.join(realHome, "workspace");
  const homebrew = path.join(directory, "opt/homebrew");
  const xcode = path.join(directory, "Applications/Xcode.app/Contents/Developer");
  const library = path.join(realHome, "Library");
  for (const target of [
    homebrew, xcode, path.join(library, "Keychains"), path.join(library, "Application Support"), path.join(realHome, ".local/share"),
    path.join(realHome, ".ssh/..metadata"), path.join(cwd, "src"), path.join(cwd, "apps/web/.legacy/app/[org]/knowledge")
  ]) fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(cwd, "src/a.txt"), "");
  fs.symlinkSync(library, path.join(cwd, "library-link"));
  fs.symlinkSync(path.join(library, "Keychains"), path.join(cwd, "keychains-link"));
  const options = { cwd, realHome };
  for (const command of [
    `find '${homebrew}' '${xcode}' -name "*USB*.h" 2>/dev/null`,
    "find -H -P . src -name '*.mjs' -type f",
    "find apps/web/.legacy/app/[org] -maxdepth 4 -type f",
    "find 'apps/web/.legacy/app/[org]' -maxdepth 4 -type f",
    "find apps/web/.legacy/app/\\[org\\]/knowledge -type f",
    "find src/[a-z]* -type f", "find src* -type f"
  ]) assert.equal(isReadOnlyCommand(command, options), true, command);
  for (const command of [
    "find -L -H -P . src -name '*.mjs' -type f", "find -P -L . -print", "find -H . -follow -print",
    "find ~/Library -print", "find ~/.local -print", "find ~/ -print",
    `find '${realHome}' -name x`, `find '${directory}' -print`, `find '${library}/Keychains' -print`, "find / -print",
    "find ../Library -print", "find ../.ssh/..metadata -print", "find . src ../.local -print", "find src missing -print",
    "find library-link -print", "find keychains-link/.. -print", "find ./library* -print", "find '' -print",
    "find ~/Lib* -print", "find ./library*/Keychains -print", "find * -print", "find .* -print", `find '${directory}'/*/.ssh -print`
  ]) assert.equal(isReadOnlyCommand(command, options), false, command);
  assert.equal(isReadOnlyCommand("find /Users/*/.ssh -print", { cwd, realHome: "/Users/agy-test-home" }), false);
  assert.equal(isReadOnlyCommand("find . -print", { cwd: realHome, realHome }), false);
  assert.equal(isReadOnlyCommand("find -print", { cwd: realHome, realHome }), false);
});

for (const flag of "-name -iname -path -ipath -wholename -regex -iregex -type -maxdepth -mindepth -size -mtime -mmin -newer".split(" ")) {
  test(`checks find value predicate ${flag}`, () => {
    assert.equal(isReadOnlyCommand(`find . '${flag}' value`), true);
    assert.equal(isReadOnlyCommand(`find . ${flag}`), false);
    assert.equal(isReadOnlyCommand(`find . ${flag} '-delete' -print`), true);
  });
}

for (const flag of "-empty -print -print0 -prune -not -a -o -and -or -ls".split(" ")) {
  test(`accepts find predicate ${flag}`, () => assert.equal(isReadOnlyCommand(`find . ${flag} -empty`), true));
}

const gitFlags = {
  status: ["-s --short --porcelain -b --branch -u --untracked-files --ignored", "", "--porcelain -u --untracked-files --ignored"],
  log: ["--oneline -p --patch --stat --shortstat --name-only --name-status --graph --decorate --pretty --follow --all --reverse --first-parent --no-merges --abbrev-commit -20", "-n --max-count --format --author --since --until --after --before --grep -S -G --date", "--stat --decorate --pretty"],
  show: ["--stat --shortstat --name-only --name-status -p --patch --pretty --no-patch -s --abbrev-commit", "--format --date", "--stat --pretty"],
  diff: ["--stat --shortstat --name-only --name-status --cached --staged --word-diff --no-color --numstat --summary --unified -M", "-U", "--stat --unified --word-diff -M"],
  "ls-files": ["-c --cached -m --modified -o --others -i --ignored --exclude-standard -s --stage -z", "", ""],
  grep: ["-n --line-number -i --ignore-case -w --word-regexp -l --files-with-matches -c --count -E -F -P --cached --untracked -I", "-e --max-depth", ""],
  blame: ["-w -M -C --porcelain -s -e", "-L", "-M -C"],
  "rev-parse": ["--show-toplevel --abbrev-ref --short --verify --git-dir --is-inside-work-tree HEAD", "", "--abbrev-ref --short"],
  branch: ["--list -a --all -r --remotes -v -vv --show-current", "", ""]
};

for (const [subcommand, [bare, required, optional]] of Object.entries(gitFlags)) {
  for (const flag of bare.split(" ")) {
    test(`accepts git ${subcommand} flag ${flag}`, () => assert.equal(isReadOnlyCommand(`git ${subcommand} '${flag}'`), true));
  }
  for (const flag of [...required.split(" ").filter(Boolean), ...optional.split(" ").filter(Boolean)]) {
    test(`checks git ${subcommand} value flag ${flag}`, () => {
      assert.equal(isReadOnlyCommand(`git ${subcommand} '${flag}=value'`), true);
      assert.equal(isReadOnlyCommand(`git ${subcommand} ${flag} value`), true);
      if (required.split(" ").includes(flag)) assert.equal(isReadOnlyCommand(`git ${subcommand} ${flag}`), false);
    });
  }
  test(`rejects unknown git ${subcommand} flags after operands`, () => {
    assert.equal(isReadOnlyCommand(`git ${subcommand} HEAD --unknown`), false);
    assert.equal(isReadOnlyCommand(`git ${subcommand} -Z`), false);
  });
}

test("git short value flags accept attached numbers", () => {
  for (const command of ["git diff -U3 HEAD~1", "git diff --unified=3 HEAD~1", "git log -n5", "git log -pn5", "git diff -M50 HEAD~1", "git blame -M50 file"]) {
    assert.equal(isReadOnlyCommand(command), true, command);
  }
  for (const command of ["git diff -U", "git diff -Uabc HEAD~1", "git diff --unified= HEAD~1", "git log -n", "git log -nabc", "git diff -M50extra HEAD~1", "git blame -Mabc file", "git status -s3"]) {
    assert.equal(isReadOnlyCommand(command), false, command);
  }
});

for (const separator of ["\v", "\f", "\u00a0", "\u1680", "\u2028", "\u3000", "\ufeff", "\u200b", "\u0085", "\x1b", "\x7f"]) {
  test(`refuses shell word character ${JSON.stringify(separator)} that splits only for the checker`, () => {
    for (const command of [`rg x${separator}-e --pre=sh script.sh`, `git log --format=x${separator}-- --output=/tmp/out`, `find src x${separator}-name -delete`, `cat${separator}/x`, `cat 'a${separator}b'`, `cat "a${separator}b"`, `cat a\\${separator}b`]) {
      assert.equal(isReadOnlyCommand(command), false, JSON.stringify(command));
    }
  });
}
test("accepts tab separated words and escaped spaces", () => {
  assert.equal(isReadOnlyCommand("cat\tREADME.md"), true);
  assert.equal(isReadOnlyCommand("cat a\\ file.txt"), true);
});
for (const command of ["tail --f x", "tail --fo x", "tail --foll=name x", "tail --follow x"]) {
  test(`refuses tail follow prefix ${command}`, () => assert.equal(isReadOnlyCommand(command), false));
}
