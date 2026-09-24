import type { Mode } from './api.js';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Keep only SDK event structure. Never persist prompts, model text, tool arguments, or errors. */
export function summarizeSdkMessage(message: unknown) {
  if (!record(message)) return undefined;
  if (message.type === 'system' && message.subtype === 'init') {
    const servers = Array.isArray(message.mcp_servers) ? message.mcp_servers : [];
    const authorize = servers.find((server: unknown) => record(server) && server.name === 'authorize');
    const status = record(authorize) ? authorize.status : undefined;
    const safeStatuses = new Set(['connected', 'connecting', 'failed', 'disconnected']);
    return {
      type: 'system' as const,
      subtype: 'init' as const,
      authorizeMcpStatus: typeof status === 'string' && safeStatuses.has(status) ? status : 'not reported',
    };
  }
  if (message.type === 'assistant') {
    const assistant = record(message.message) ? message.message : undefined;
    const content = assistant && Array.isArray(assistant.content) ? assistant.content : [];
    const safeTypes = new Set(['text', 'tool_use', 'thinking', 'redacted_thinking']);
    const blockTypes = content.map((block: unknown) => record(block) ? block.type : undefined)
      .filter((type: unknown): type is string => typeof type === 'string' && safeTypes.has(type));
    return {type: 'assistant' as const, blockTypes};
  }
  if (message.type === 'result') {
    const safeSubtypes = new Set(['success', 'error_during_execution', 'error_max_turns', 'error_max_budget_usd', 'error_max_structured_output_retries']);
    return {type: 'result' as const, subtype: typeof message.subtype === 'string' && safeSubtypes.has(message.subtype)
      ? message.subtype : 'other'};
  }
  return undefined;
}

export interface AuthorizeRunEvidence {
  mode: Mode;
  report: string;
  isError: boolean;
  toolCalls: readonly string[];
  changeAttempts: number;
  changeSucceeded: number;
  verifiedChanges: number;
}

/** A model's text-only success cannot establish that a requested operation ran. */
export function finalizeAuthorizeRun(evidence: AuthorizeRunEvidence) {
  const original = evidence.report.trim();
  if (evidence.toolCalls.length === 0) {
    return {
      isError: true,
      report: `No Authorize tool calls occurred; no PingOne Authorize read or change was performed. ${
        evidence.isError ? original : 'The specialist returned text without using its tools.'}`.trim(),
    };
  }
  if (evidence.mode !== 'inspect' && evidence.changeAttempts === 0) {
    return {
      isError: true,
      report: `No authorize_change call occurred; no requested change or evaluation was performed. ${original}`.trim(),
    };
  }
  if (evidence.mode === 'author' && evidence.changeSucceeded > evidence.verifiedChanges) {
    return {
      isError: true,
      report: `${original}\n\nA change call may have written configuration, but readback verification is incomplete. Inspect the current state before retrying.`,
    };
  }
  return {isError: evidence.isError || !original, report: original};
}
