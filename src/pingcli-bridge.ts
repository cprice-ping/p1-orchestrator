/**
 * pingcli-bridge.ts — the supply-side escape hatch.
 *
 * When the P1 MCP catalog lacks a domain's tools (Protect today), the
 * orchestrator exposes fallback tools that shell out to `pingcli`. The
 * specialist's playbook calls the SAME conceptual operations
 * (listRiskPolicySets, createRiskPolicySet…) and never knows which
 * transport executed them: catalog hit → native MCP; catalog miss +
 * fallback mapping → CLI with --output-format json.
 *
 * Auth: pingcli's own profiles (keychain-held client credentials). Trust
 * chain unchanged — P1 enforces the identity's roles per call; pingcli
 * is just a different client of the same APIs.
 *
 * When the P1 MCP server ships Protect tools, the launcher prefers the
 * catalog and these fallbacks stop matching — the mapping retires itself.
 */

import { spawn } from "node:child_process";

export interface CliFallback {
  /** CLI subcommand under `pingcli pingone protect …` (or full custom). */
  args: string[];
  /** Extra flags the CLI needs (e.g. stdin file for create). */
  stdin?: boolean;
  /** One-line description for the exposed tool. */
  description: string;
}

export interface FallbackSpec {
  /** MCP-style tool name the specialist knows: listRiskPolicySets etc. */
  [mcpToolName: string]: CliFallback;
}

export const PROTECT_FALLBACKS: FallbackSpec = {
  listRiskPolicySets: {
    args: ["pingone", "protect", "risk-policy-sets", "list"],
    description: "List all PingOne Protect risk policy sets in the environment.",
  },
  getRiskPolicySet: {
    args: ["pingone", "protect", "risk-policy-sets", "get"],
    description: "Read a specific PingOne Protect risk policy set by ID.",
  },
  createRiskPolicySet: {
    args: ["pingone", "protect", "risk-policy-sets", "create", "--file", "-"],
    stdin: true,
    description:
      "Create a PingOne Protect risk policy set. Pass the full JSON policy-set body.",
  },
  updateRiskPolicySet: {
    args: ["pingone", "protect", "risk-policy-sets", "replace", "--file", "-"],
    stdin: true,
    description: "Replace an existing risk policy set. Pass the full JSON body.",
  },
  deleteRiskPolicySet: {
    args: ["pingone", "protect", "risk-policy-sets", "delete"],
    description: "Delete a PingOne Protect risk policy set by ID.",
  },
  listRiskPredictors: {
    args: ["pingone", "protect", "risk-predictors", "list"],
    description: "List all PingOne Protect risk predictors in the environment.",
  },
  getRiskPredictor: {
    args: ["pingone", "protect", "risk-predictors", "get"],
    description: "Read a specific PingOne Protect risk predictor by ID.",
  },
  createRiskPredictor: {
    args: ["pingone", "protect", "risk-predictors", "create", "--file", "-"],
    stdin: true,
    description: "Create a PingOne Protect risk predictor. Pass the full JSON body.",
  },
};

/** Run one pingcli command; return parsed output or a rich error.
 *  Profile is PINNED (default: prod) so the bridge's identity is fixed
 *  regardless of the user's active CLI profile — one worker, one scope,
 *  managed in PingOne, not in local CLI state. */
const PINGCLI_PROFILE = process.env.PINGCLI_PROFILE ?? "prod";

export async function runPingcli(
  args: string[],
  opts: { environmentId: string; stdinBody?: string; positional?: string[] },
): Promise<{ ok: boolean; text: string }> {
  const full = [
    "--profile",
    PINGCLI_PROFILE,
    ...args,
    "--environment-id",
    opts.environmentId,
    "-O",
    "json",
    ...(opts.positional ?? []),
  ];

  return new Promise((resolve) => {
    const child = spawn("pingcli", full, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    if (opts.stdinBody !== undefined) {
      child.stdin.write(opts.stdinBody);
    }
    child.stdin.end();
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, text: `pingcli timed out: pingcli ${args.join(" ")}` });
    }, 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = out || err || "(no output)";
      if (code === 0) {
        resolve({ ok: true, text: text.slice(0, 24_000) });
      } else {
        resolve({
          ok: false,
          text: `pingcli exit ${code}: ${text.slice(0, 2000)}`,
        });
      }
    });
  });
}
