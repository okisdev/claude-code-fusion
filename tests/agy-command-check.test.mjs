import assert from "node:assert/strict";
import test from "node:test";
import { isReadOnlyCommand } from "../plugins/agy/scripts/lib/agy-command-check.mjs";

for (const command of ["ls -la", "pwd", "cat README.md", "head -n 20 README.md", "tail -n 10 log.txt", "wc -l README.md", "stat README.md", "grep -n TODO src", "rg --files", "rg -n 'two words' src", 'cat "a file.txt"', "find . -name '*.mjs'", "find . -type f -print", "git status --short", "git log --oneline -5", "git show --stat", "git diff --cached --stat", "git ls-files --cached", "git grep --cached", "git rev-parse --show-toplevel", "git branch", "git branch --list -a -r -v", "git status path", "git log main", "git show HEAD", "git diff HEAD", "git ls-files src", "git grep pattern", "git blame file", "git rev-parse HEAD", "git branch --show-current", "git branch -av", "  pwd\t ",
  'rg -n "kSecAttrAccessGroup|appGroupIdentifier|keychain-access-groups" apps/apple',
  'rg "next/|use client|server-only|:\\s*any\\b|as any\\b" apps/web/routes/auth',
  "find apps/web/.legacy/app/[org] -maxdepth 4 -type f",
  "find apps/web/.legacy/app/\\[org\\]/knowledge -type f",
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
  "find -L -H -P . src -name '*.mjs' -type f", "find . '(' -name '*.mjs' -o -name '*.js' ')' '!' -empty -print"
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
  "find . -L", "find . -unknown", "find . -print -delete", "find . -print unexpected", "find . -name", "find . ( -print )", "find . ! -empty",
  "git --git-dir=.git log", "git -C . status", "git --exec-path=bin log", "git status --unknown", "git status -suZ", "git log -np 20", "git log --oneline=true",
  "git branch -avD main", "git branch -- --list new", "git branch --list=topic", "git branch --all new", "git diff --textconv", "git grep '-nO' sh foo",
  "git log --format --output=x", "git log --pretty --output=x", "git diff -U --output=x", "git diff --unified --output=x", "git show --format --output=x"
]) {
  test(`rejects parsed command ${JSON.stringify(command)}`, () => assert.equal(isReadOnlyCommand(command), false));
}

for (const flag of "--hidden --no-ignore --files --files-with-matches --count --line-number --no-line-number --ignore-case --smart-case --case-sensitive --fixed-strings --word-regexp --invert-match --multiline --json --follow --with-filename --no-heading --heading --null --only-matching".split(" ")) {
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

for (const flag of "niSsFwvlcULHNoux") {
  test(`accepts rg short flag ${flag} in a cluster`, () => assert.equal(isReadOnlyCommand(`rg -n${flag} needle src`), true));
}

for (const flag of "egtTABCmM") {
  test(`checks rg short value flag ${flag}`, () => {
    for (const argument of [`-${flag}value`, `-n${flag}value`, `-${flag} value`, `-${flag}=value`]) assert.equal(isReadOnlyCommand(`rg ${argument} needle src`), true);
    assert.equal(isReadOnlyCommand(`rg -${flag}`), false);
  });
}

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
  diff: ["--stat --shortstat --name-only --name-status --cached --staged --word-diff --no-color --numstat --summary -U --unified", "", "--stat -U --unified --word-diff"],
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
