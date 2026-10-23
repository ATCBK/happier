import type { PromptBundleEntryV1 } from '../promptBundleSchemas.js';
import { encodeBase64 } from '../../../crypto/base64.js';
import type { SkillRuleV1 } from '../../../reach/reachRuleV1.js';
import type { ReadOnlySkillProvenanceV1 } from './skillLibraryItemV1.js';

/** Host-owned content, projected afresh from the current built-in or plugin occurrence. */
export type ReadOnlySkillV1 = Readonly<{
  skillId: string; files: readonly PromptBundleEntryV1[]; provenance: ReadOnlySkillProvenanceV1;
}>;

export type FirstPartySkillV1 = ReadOnlySkillV1 & Readonly<{
  skillId: `happier:${string}`; name: string; description: string; files: readonly PromptBundleEntryV1[];
  provenance: Readonly<{ kind: 'first_party' }>;
}>;

const happierGuide = `---
name: happier
description: Use Happier from this session
---

Use the Happier tools delivered in this session, through MCP or a native extension.
Find \`action_spec_search\`, \`action_spec_get\`, and \`action_execute\` among your
available tools; their server prefix may vary. Search for the operation, read its
current schema, then execute its returned Action id with \`{ actionId, input }\`.
A missing direct tool for an Action does not mean the Action is unavailable.
Follow the returned availability, permission, and approval requirements.

For standalone CLI operations, first check that \`happier\` is on PATH and
authenticated to the intended Happier Home. Read \`happier --help\`, then
\`happier skills --help\`, \`happier mcp --help\`, or \`happier session --help\` as needed.
The CLI uses its own authenticated identity; it does not inherit this turn's
requester. Do not switch channels to bypass a refusal or approval requirement.
If a requester cannot be identified, ask the person to send a fresh request from
their signed-in Happier app. If no usable channel is available, say so.
`;

/** Bundled content uses the same digest and materializer as Account skill bundles. */
export const FIRST_PARTY_SKILLS_V1: readonly FirstPartySkillV1[] = [{
  skillId: 'happier:happier', name: 'happier', description: 'Use Happier from this session',
  provenance: { kind: 'first_party' },
  files: [{ path: 'SKILL.md', contentKind: 'utf8', contentBase64: encodeBase64(new TextEncoder().encode(happierGuide), 'base64') }],
}];

/** The set is fixed at row creation; a later stub needs its own explicit seeding decision. */
export function buildFirstPartySkillSeedRuleV1(skillId: string, nowMs: number): SkillRuleV1 {
  return { id: `first-party:${skillId}`, skillId, target: { t: 'allMachines' }, enabled: true,
    createdAt: nowMs, updatedAt: nowMs };
}
