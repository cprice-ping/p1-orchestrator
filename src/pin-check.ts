/**
 * pin-check.ts — freshness check for curated pins: every pin is HEAD-probed
 * to confirm it still resolves. Content freshness is the docs service's job
 * (agent-fronted retrieval over the live corpus); this only validates that
 * our hand-curated overrides still point at real pages. Run in CI or
 * pre-demo.
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
