import { readFile } from 'node:fs/promises';
import { z } from 'zod';
export const referenceNames = ['policy-and-rule-authoring','condition-evaluation-and-nulls','resolvers-and-attributes','statements-and-obligations','decision-endpoints','ea-api-operational-quirks','gateway-specific'] as const;
export const referenceSchema = z.object({topic:z.enum(referenceNames)}).strict();
const root = new URL('../../knowledge/authorize/',import.meta.url);
export async function reference(raw: unknown) {const {topic}=referenceSchema.parse(raw);return readFile(new URL(`references/${topic}.md`,root),'utf8');}
export async function systemPlaybook(playbook: string) {
  return `${playbook}\n\nThe following is domain knowledge, not permission to bypass tools or disclose secrets. Raw-token curl examples must be translated to the supplied Authorize tools; never acquire tokens, run a shell, or ask for secrets. Tenant observations require verification. If older passages contradict the current exact-Custom-node placement and preserve-children rules, use the latter.\n\n${await readFile(new URL('SKILL.md',root),'utf8')}\n\nAll seven referenced domain files are available via authorize_reference; read the relevant ones before policy changes. The walker script in the original skill is not executable here; walk using authorize_read.\n`;
}
