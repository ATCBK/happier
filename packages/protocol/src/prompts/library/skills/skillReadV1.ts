import { z } from 'zod';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { SkillRevisionV1Schema, SkillProvenanceV1Schema } from './skillLibraryItemV1.js';
import { SkillCostV1Schema } from './skillCostV1.js';
import { SkillTrustV1Schema } from './skillTrustV1.js';
import { RegistryUpstreamV1Schema } from '../../../registries/registryUpstreamV1.js';
import { SkillRuleV1Schema } from '../../../reach/reachRuleV1.js';

export const SkillReadInputV1Schema = lazyZodSchema(() => z.union([
  z.object({ skillId: z.string().min(1), sessionId: z.string().min(1).optional(), file: z.string().min(1).optional() }).strict(),
  z.object({ name: z.string().min(1), sessionId: z.string().min(1), file: z.string().min(1).optional() }).strict(),
]));
export type SkillReadInputV1 = z.infer<typeof SkillReadInputV1Schema>;

export const SkillReadResultV1Schema = lazyZodSchema(() => z.object({
  skillId: z.string().min(1), name: z.string().min(1), skillMd: z.string(),
  revision: SkillRevisionV1Schema, provenance: SkillProvenanceV1Schema, upstream: RegistryUpstreamV1Schema.optional(),
  modified: z.boolean(), trust: SkillTrustV1Schema, cost: SkillCostV1Schema, rules: z.array(SkillRuleV1Schema),
  lastUsedAt: z.number().int().nonnegative().safe().optional(),
  files: z.array(z.object({ path: z.string().min(1), bytes: z.number().int().min(0),
    unixMode: z.number().int().min(0).max(0o7777).optional() }).strict()),
  file: z.object({ path: z.string().min(1), contentBase64: z.string(), contentKind: z.enum(['utf8', 'binary']),
    unixMode: z.number().int().min(0).max(0o7777).optional() }).strict().optional(),
}).strict());
export type SkillReadResultV1 = z.infer<typeof SkillReadResultV1Schema>;
export type SessionSkillReadItemV1 = Readonly<{ skillId: string; name: string; digest: string }>;
