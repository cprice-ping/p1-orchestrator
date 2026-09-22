/**
 * runlog.ts — shared run-log writer. Both engines (claude, gemini) append
 * the same NDJSON shape to ~/.p1-orchestrator/runs/ so visibility tooling
 * doesn't care which engine ran.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export async function writeRunLog(
  specialist: string,
  data: {
    toolCalls: string[];
    toolArgs: string[];
    report: string;
    engine?: string;
  },
): Promise<string> {
  const dir = join(homedir(), ".p1-orchestrator", "runs");
  await mkdir(dir, { recursive: true });
  const path = join(
    dir,
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${specialist}.ndjson`,
  );
  const lines: string[] = [];
  const ts = () => new Date().toISOString();
  data.toolCalls.forEach((name, i) => {
    lines.push(
      JSON.stringify({ ts: ts(), event: "tool_call", engine: data.engine, name, argsPreview: data.toolArgs[i] }),
    );
  });
  lines.push(JSON.stringify({ ts: ts(), event: "done", engine: data.engine, report: data.report }));
  await appendFile(path, lines.join("\n") + "\n").catch(() => {});
  return path;
}
