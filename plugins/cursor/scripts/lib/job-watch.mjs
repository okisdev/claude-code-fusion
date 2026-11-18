import { fileURLToPath } from "node:url";

export function backgroundWatchReceipt(engine, jobId) {
  const companion = fileURLToPath(new URL(`../${engine}-companion.mjs`, import.meta.url));
  const quoted = companion.replace(/[\\"$`]/g, "\\$&");
  const watchCommand = `node "${quoted}" watch --job ${jobId}`;
  return {
    watchCommand,
    watchInstruction: `The main session must start one Claude Code Monitor tool watch with command: ${watchCommand}. The watch completion line is the cue to collect with /${engine}:result ${jobId}.`
  };
}

export async function watchJob(argv, { engine, readJob }) {
  if (argv.length !== 2 || argv[0] !== "--job" || !/^[a-f0-9]{32}$/.test(argv[1])) {
    throw new Error("watch requires --job followed by a 32 character lowercase hexadecimal job id.");
  }
  const jobId = argv[1];
  for (;;) {
    const record = await readJob(jobId);
    if (!record) throw new Error(`No job record found for ${jobId}.`);
    if (["done", "error", "cancelled"].includes(record.status)) {
      const failure = record.failureKind ? ` (${String(record.failureKind).replace(/\s+/g, " ")})` : "";
      process.stdout.write(`${engine} job ${jobId} ${record.status}${failure}. collect with /${engine}:result ${jobId}; completion notices do not replace collection.\n`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 15000));
  }
}
