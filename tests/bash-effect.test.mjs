import assert from "node:assert";
import path from "node:path";
import { test } from "node:test";
import { bashWriteEffect, isReadOnlyBash } from "../plugins/fusion/scripts/lib/guard/bash-effect.mjs";

const cwd = path.resolve("/workspace/repo");

test("read only Bash classification accepts only commands that leave the workspace unchanged", () => {
  const cases = [
    ["cd src && rg pattern . | head -20; wc -l file", true],
    ["sed -n '1,10p' file", true],
    ["sed -n 605,665p a.tsx && sed -n 500,540p b.tsx", true],
    ["sed -n 1,75p a.ts; echo '----'; grep -n pattern b.ts | cut -c1-200 | sort | uniq -c", true],
    ["cat file", true],
    ["grep pattern file", true],
    ["rg 'foo|bar' file", true],
    ["head file", true],
    ["tail file", true],
    ["ls -la", true],
    ["wc -l file", true],
    ["find . -name '*.mjs'", true],
    ["awk '{ print $1; }' file", true],
    ["nl -ba file", true],
    ["jq '.items[]' file", true],
    ["tree src", true],
    ["cat file || true", true],
    ["grep -c pattern file || echo none", true],
    ["git status --short\ngit log --oneline -5", true],
    ["diff a.txt b.txt", true],
    ...["diff", "show", "log", "status", "grep", "blame", "rev-parse", "ls-files", "ls-tree", "cat-file", "merge-base", "describe"].map((subcommand) => [`git ${subcommand} --help`, true]),
    ["git -C packages/app --no-pager diff HEAD", true],
    ["git worktree list", true],
    ["git stash list", true],
    ["git branch --show-current", true],
    ["git branch -a", true],
    ["git tag", true],
    ["git remote -v", true],
    ["git config --get user.name", true],
    ...["pr view", "pr diff", "pr list", "pr checks", "issue view", "issue list", "run view", "run list"].map((subcommand) => [`gh ${subcommand} 1`, true]),
    ["gh api repos/o/r/pulls/1/comments", true],
    ["gh search prs fusion", true],
    ["sed -i 's/x/y/' file", false],
    ["sed -ni '1p' file", false],
    ["sed --in-place 's/x/y/' file", false],
    ["sed --in-place=.bak 's/x/y/' file", false],
    ["sed 'w out' file", false],
    ["sed -n '1w out' file", false],
    ["sed 's/x/y/w out' file", false],
    ["find . -delete", false],
    ["find . -exec rm {} \;", false],
    ["find . -fprint out", false],
    ["find . -fprintf out '%p'", false],
    ["find . -fls out", false],
    ["awk '{ print $1 > \"out\" }' file", false],
    ["awk '{ print $1 | \"cat\" }' file", false],
    ["awk '{ system(\"touch out\") }' file", false],
    ["awk 'BEGIN { system (\"touch out\") }' file", false],
    ["cat file 2>/dev/null", true],
    ["rg pattern . 2>&1 | head", true],
    ["git checkout main", false],
    ["git branch feature", false],
    ["git branch -D feature", false],
    ["git tag v1", false],
    ["git worktree add ../wt", false],
    ["git stash pop", false],
    ["git remote add origin url", false],
    ["git config user.name x", false],
    ["gh pr edit 1", false],
    ["gh api -X POST repos/o/r/issues", false],
    ["gh api repos/o/r/issues -f title=x", false],
    ["cat file > out", false],
    ["echo text > out", false],
    ["rg pattern . | rm file", false],
    ["cat file && node script.mjs", false],
    ["cat $(touch file)", false],
    ["cat file & rm file", false],
    ["cat <<EOF\ntext\nEOF", false],
    ["cat file ;; ls", false],
    ["", false]
  ];
  for (const [command, expected] of cases) assert.strictEqual(isReadOnlyBash(command), expected, command);
});

test("a Bash command that authors a workspace file is a write", () => {
  const cases = [
    ["sed -i 's/x/y/' src/a.ts", "src/a.ts"],
    ["sed -i '' 's/x/y/' src/a.ts", "src/a.ts"],
    ["sed --in-place=.bak 's/x/y/' src/a.ts", "src/a.ts"],
    ["perl -pi -e 's/x/y/' src/a.ts", "src/a.ts"],
    ["echo text > notes.md", "notes.md"],
    ["printf '%s' text >> docs/log.md", "docs/log.md"],
    ["cat > src/new.ts <<'EOF'\nexport const a = 1;\nEOF", "src/new.ts"],
    ["git diff | tee review.patch", "review.patch"],
    ["cd packages/app && cat > src/b.ts <<EOF\nx\nEOF", "packages/app/src/b.ts"],
    [`cat src/a.ts > ${cwd}/src/copy.ts`, "src/copy.ts"],
    ["pnpm test 2> errors.log", "errors.log"],
    ["pnpm build &> build.log", "build.log"],
    ["python3 - <<'EOF'\np='src/reach.ts'\ns=open(p).read()\nopen(p,'w').write(s.replace('a','b'))\nEOF", "src/reach.ts"],
    ["python3 - <<'EOF'\nfrom pathlib import Path\nPath(\"README.md\").write_text('x')\nEOF", "README.md"],
    ["python3 -c \"open('docs/a.md','w').write('x')\"", "docs/a.md"],
    ["node -e \"require('fs').writeFileSync('src/gen.js', 'x')\"", "src/gen.js"],
    ["node --input-type=module - <<'EOF'\nimport fs from 'node:fs';\nfs.appendFileSync(\"CHANGELOG.md\", 'x');\nEOF", "CHANGELOG.md"]
  ];
  for (const [command, expected] of cases) {
    assert.strictEqual(bashWriteEffect(command, cwd)?.path, path.join(cwd, expected), command);
  }
  assert.strictEqual(bashWriteEffect("cat > src/new.ts <<'EOF'\nexport const a = 1;\nEOF", cwd).bytes, Buffer.byteLength("export const a = 1;"));
  assert.strictEqual(bashWriteEffect("sed -i 's/x/y/' src/a.ts", cwd).bytes, 0);
});

test("a Bash command that leaves workspace files alone is not a write", () => {
  const commands = [
    "",
    "sed -n '1,10p' src/a.ts",
    "cat src/a.ts 2>/dev/null",
    "rg pattern . 2>&1 | head",
    "pnpm test > /dev/null",
    "git diff HEAD --binary > /tmp/baseline.patch",
    "git diff > \"$S/review.patch\"",
    "echo text > ~/notes.md",
    "sed -i 's/x/y/' /tmp/scratch.txt",
    "sed -i 's/x/y/' \"$FILE\"",
    "cd /tmp/scratch && echo text > out.txt",
    "cd \"$S\" && echo text > out.txt",
    "S=/tmp/scratch; cat > $S/probe.mjs <<'EOF'\nconsole.log(1)\nEOF",
    "node scripts/generate.mjs",
    "pnpm --dir apps/desktop test",
    "git apply /tmp/peer.patch",
    "python3 - <<'EOF'\nimport sys\ns=open('src/a.ts').read()\nsys.stdout.write(s[:100])\nEOF",
    "node -e \"process.stdout.write(require('fs').readFileSync('package.json', 'utf8'))\"",
    "python3 - <<'EOF'\nopen('/tmp/scratch/out.json','w').write('{}')\nEOF",
    "python3 - <<'EOF'\nimport os\nopen(os.environ['OUT'],'w').write('x')\nEOF",
    "python3 -c \"print(open('src/a.ts').read())\""
  ];
  for (const command of commands) assert.strictEqual(bashWriteEffect(command, cwd), null, command);
  assert.strictEqual(bashWriteEffect("echo text > notes.md", "relative/cwd"), null);
  assert.strictEqual(bashWriteEffect(null, cwd), null);
});
