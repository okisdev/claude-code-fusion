import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "--check")) {
    throw new Error("Usage: node shared/sync.mjs [--check]");
  }

  const check = process.argv[2] === "--check";
  const manifest = JSON.parse(
    await readFile(path.join(root, "shared", "companion", "manifest.json"), "utf8")
  );
  const drift = [];

  for (const [source, targets] of Object.entries(manifest)) {
    const sourcePath = path.join(root, "shared", "companion", source);
    const sourceBytes = await readFile(sourcePath);

    for (const target of targets) {
      const targetPath = path.join(root, target);
      if (check) {
        let targetBytes;
        try {
          targetBytes = await readFile(targetPath);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        if (!targetBytes?.equals(sourceBytes)) drift.push(target);
      } else {
        await mkdir(path.dirname(targetPath), { recursive: true });
        await copyFile(sourcePath, targetPath);
      }
    }
  }

  if (drift.length) {
    for (const target of drift) console.error(target);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
