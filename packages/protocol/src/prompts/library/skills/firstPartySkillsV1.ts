import type { PromptBundleEntryV1 } from '../promptBundleSchemas.js';

export type FirstPartySkillV1 = Readonly<{
  skillId: `happier:${string}`; name: string; description: string; files: readonly PromptBundleEntryV1[];
}>;

/** U11 activates bundled content together with the once-only skill-rules row seed. */
export const FIRST_PARTY_SKILLS_V1: readonly FirstPartySkillV1[] = [];
