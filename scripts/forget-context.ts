// Remove lines from the active company context, e.g. an owner Q&A that should not be there:
//   npm run forget -- "Are clothes separated by color"          (dry run: shows what would go)
//   npm run forget -- "Are clothes separated by color" --apply  (saves a new Knowledge version without those lines)
// The teacher's LEARNED RULES block is never touched. The old text stays in the version history (restore it any time).
import dotenv from "dotenv";
import { createDataStore } from "../src/services/data/store";

dotenv.config();

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const phrase = args.filter((a) => !a.startsWith("--")).join(" ").trim();
  if (phrase.length < 6) {
    console.error('Usage: npm run forget -- "text of the line to remove" [--apply]   (at least 6 characters, so you cannot match half the context by accident)');
    process.exit(1);
  }

  const store = await createDataStore();
  const cfg = await store.getActiveConfig();
  const kept: string[] = [];
  const removed: string[] = [];
  let inRules = false;
  for (const line of cfg.context.split("\n")) {
    if (line.includes("END OF LEARNED RULES")) {
      inRules = false;
      kept.push(line);
      continue;
    }
    if (line.includes("LEARNED RULES")) inRules = true;
    (!inRules && line.toLowerCase().includes(phrase.toLowerCase()) ? removed : kept).push(line);
  }

  if (removed.length === 0) {
    console.log(`Nothing in Knowledge v${cfg.version} matches "${phrase}" (the learned rules block is never searched).`);
    process.exit(0);
  }
  console.log(`Knowledge v${cfg.version}: ${removed.length} line(s) would be removed:`);
  removed.forEach((l) => console.log(`  - ${l}`));
  if (!apply) {
    console.log("\nDry run. Run again with --apply to save it as a new version.");
    process.exit(0);
  }
  const saved = await store.saveConfigVersion({
    companyName: cfg.companyName,
    greeting: cfg.greeting,
    context: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    author: "manager",
    note: `Removed: ${phrase}`.slice(0, 300),
  });
  console.log(`\n✓ Saved Knowledge v${saved.version} without those lines. The previous text is still in the history (v${cfg.version}).`);
  process.exit(0);
}

main().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : err);
  process.exit(1);
});
