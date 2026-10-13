import { z } from 'zod';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../../json/storedReadSchema.js';
import { RegistryContentRefV1Schema, RegistryProvenanceV1Schema } from '../../../registries/registryItemsV1.js';
import { RegistryUpstreamV1Schema } from '../../../registries/registryUpstreamV1.js';
import { SkillRuleV1Schema } from '../../../reach/reachRuleV1.js';
import { ArtifactRevisionV1Schema } from '../../../artifacts/artifactRevisionV1.js';
import { SkillTrustV1Schema } from './skillTrustV1.js';
import { SkillCostV1Schema } from './skillCostV1.js';

export type SkillLibraryItemV1 = Readonly<{
  skillId: string; name: string; digest: string; description: string;
  disableModelInvocation: boolean; userInvocable: boolean; updatedAt?: number;
}>;

export const SkillProvenanceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('registry'), registry: RegistryProvenanceV1Schema }).strict(),
  z.object({ kind: z.literal('link'), url: z.string().min(1), ref: RegistryContentRefV1Schema }).strict(),
  z.object({ kind: z.literal('machine'), machineId: z.string().min(1), agentIds: z.array(z.string()), path: z.string().min(1), importedAt: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('upload'), importedAt: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('written') }).strict(),
  z.object({ kind: z.literal('first_party') }).strict(),
]));
export type SkillProvenanceV1 = z.infer<typeof SkillProvenanceV1Schema>;
export const SkillLockV1Schema = lazyZodSchema(() => z.object({ provenance: SkillProvenanceV1Schema,
  importedDigest: z.string().min(1).optional(), updatePolicy: z.enum(['manual', 'auto', 'pinned']), upstream: RegistryUpstreamV1Schema.optional() }).strict());
export type SkillLockV1 = z.infer<typeof SkillLockV1Schema>;
const SkillLockStoredV1Schema = createStoredReadSchema(SkillLockV1Schema);
export function readSkillLockV1(header: unknown): SkillLockV1 {
  const raw = header && typeof header === 'object' && 'skillLock' in header ? header.skillLock : undefined;
  if (raw === undefined) return { provenance: { kind: 'written' }, updatePolicy: 'manual' };
  const parsed = SkillLockStoredV1Schema.safeParse(raw);
  if (!parsed.success || parsed.data.provenance.kind === 'first_party') throw Object.assign(new Error('invalid_skill_lock'), { code: 'invalid_skill_lock' });
  return parsed.data;
}
export function isSkillModifiedV1(lock: SkillLockV1, currentDigest: string): boolean {
  return (lock.provenance.kind === 'registry' || lock.provenance.kind === 'link')
    && lock.importedDigest !== currentDigest;
}
export const SkillRevisionV1Schema = lazyZodSchema(() => z.union([z.string().regex(/^sha256:[0-9a-f]{64}$/), z.string().regex(/^\d+:\d+$/).refine(value => {
  const [headerVersion, bodyVersion] = value.split(':').map(Number);
  return ArtifactRevisionV1Schema.safeParse({ headerVersion, bodyVersion }).success;
})]));
export function encodeSkillRevisionV1(revision: Readonly<{ headerVersion: number; bodyVersion: number }>): string {
  const valid = ArtifactRevisionV1Schema.parse(revision);
  return `${valid.headerVersion}:${valid.bodyVersion}`;
}
export function decodeSkillRevisionV1(revision: string): Readonly<{ headerVersion: number; bodyVersion: number }> {
  const [headerVersion, bodyVersion] = revision.split(':').map(Number);
  return ArtifactRevisionV1Schema.parse({ headerVersion, bodyVersion });
}
export const SkillListItemV1Schema = lazyZodSchema(() => z.object({
  skillId: z.string().min(1), name: z.string().min(1), description: z.string().nullable(), revision: SkillRevisionV1Schema,
  rules: z.array(SkillRuleV1Schema), trust: SkillTrustV1Schema, cost: SkillCostV1Schema,
  provenance: SkillProvenanceV1Schema, modified: z.boolean(), updatePolicy: z.enum(['manual', 'auto', 'pinned']), upstream: RegistryUpstreamV1Schema.optional(),
  lastUsedAt: z.number().int().nonnegative().optional(), createdAt: z.number().int().nonnegative(), migratedFromContext: z.boolean(), userInvocable: z.boolean(), folderId: z.string().nullable(),
}).strict());
export type SkillListItemV1 = z.infer<typeof SkillListItemV1Schema>;

export const SKILL_NAME_PATTERN_V1 = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** One frontmatter projection for registry discovery, delivery and the picker. */
export function readSkillFrontmatterV1(markdown: string): Readonly<{
  name?: string; description?: string; disableModelInvocation: boolean; userInvocable: boolean;
}> {
  const match = markdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
  const out: { name?: string; description?: string; disableModelInvocation: boolean; userInvocable: boolean } = {
    disableModelInvocation: false, userInvocable: true,
  };
  if (!match) return out;
  for (const line of match[1]!.split(/\r?\n/)) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    if (!value) continue;
    if (key === 'name' && SKILL_NAME_PATTERN_V1.test(value)) out.name = value;
    if (key === 'description') out.description = value;
    if (key === 'disable-model-invocation') out.disableModelInvocation = value === 'true';
    if (key === 'user-invocable') out.userInvocable = value !== 'false';
  }
  return out;
}
