import { z } from 'zod/mini';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { SkillRevisionV1Schema, SkillProvenanceV1Schema } from './skillLibraryItemV1.js';
import { SkillCostV1Schema } from './skillCostV1.js';
import { SkillTrustV1Schema } from './skillTrustV1.js';
import { RegistryUpstreamV1Schema } from '../../../registries/registryUpstreamV1.js';
import { SkillRuleV1Schema } from '../../../reach/reachRuleV1.js';

export const SkillReadInputV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ skillId: z.string().check(z.minLength(1)), sessionId: z.optional(z.string().check(z.minLength(1))), file: z.optional(z.string().check(z.minLength(1))) }),
  z.strictObject({ name: z.string().check(z.minLength(1)), sessionId: z.string().check(z.minLength(1)), file: z.optional(z.string().check(z.minLength(1))) }),
]));
export type SkillReadInputV1 = z.infer<typeof SkillReadInputV1Schema>;

export const SkillReadResultV1Schema = lazyZodSchema(() => z.strictObject({
  skillId: z.string().check(z.minLength(1)), name: z.string().check(z.minLength(1)), skillMd: z.string(),
  revision: SkillRevisionV1Schema, provenance: SkillProvenanceV1Schema, upstream: z.optional(RegistryUpstreamV1Schema),
  modified: z.boolean(), trust: SkillTrustV1Schema, cost: SkillCostV1Schema, rules: z.array(SkillRuleV1Schema),
  lastUsedAt: z.optional(z.number().check(z.int(), z.nonnegative(), z.int())),
  files: z.array(z.strictObject({ path: z.string().check(z.minLength(1)), bytes: z.number().check(z.int(), z.minimum(0)),
    unixMode: z.optional(z.number().check(z.int(), z.minimum(0), z.maximum(0o7777))) })),
  file: z.optional(z.strictObject({ path: z.string().check(z.minLength(1)), contentBase64: z.string(), contentKind: z.enum(['utf8', 'binary']),
    unixMode: z.optional(z.number().check(z.int(), z.minimum(0), z.maximum(0o7777))) })),
}));
export type SkillReadResultV1 = z.infer<typeof SkillReadResultV1Schema>;
export type SessionSkillReadItemV1 = Readonly<{ skillId: string; name: string; digest: string }>;
