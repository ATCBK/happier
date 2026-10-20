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

Use the installed Happier CLI to find the current commands and their arguments.
Start with \`happier --help\`. For skills, MCP servers, and sessions, read
\`happier skills --help\`, \`happier mcp --help\`, or \`happier session --help\`.
Follow that command's help for the operation you need. Actions honor the caller's
approval settings; a successful read does not authorize a write.
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
