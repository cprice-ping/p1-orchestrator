/**
 * pin-check.ts — one-shot corpus freshness check: every curated pin is
 * HEAD-probed and cross-checked against the live llms.txt index.
 * Run before demos, in CI, or on a schedule.
 */

import { checkPinFreshness } from "./corpus.js";

const report = await checkPinFreshness();
console.log(`Corpus pin freshness — ${report.checkedAt}`);
console.log(`  ${report.total} pins | ${report.dead} dead | ${report.drift} drifting\n`);
for (const p of report.pins) {
  const mark = p.status === "ok" ? "✓" : p.status === "drift" ? "~" : "✗";
  console.log(`  ${mark} [${p.topic}] ${p.title}`);
  if (p.detail) console.log(`      ${p.detail}`);
  console.log(`      ${p.url}`);
}
process.exit(report.dead > 0 ? 1 : 0);
