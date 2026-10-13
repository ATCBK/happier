import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema, defineStoredReadProjection } from '../../json/storedReadSchema.js';
import { PromptStackEntryV1Schema } from './promptStacksV1.js';
import { PromptFoldersV1RecordSchema } from './promptFoldersV1.js';
import { PromptInvocationEntryV1Schema } from './promptInvocationsV1.js';
import { PromptExternalLinkEntryV1Schema, PromptExternalLinksV1Schema } from './promptExternalLinksV1.js';
import { RegistrySourcesRecordV1Schema, RegistrySourcesReadEnvelopeV1Schema, readRegistrySourcesRecordV1 } from '../../registries/registrySourcesV1.js';
import { ContextSelectionV1Schema } from './contextSelectionsV1.js';
import { RoleOverrideRecordV1Schema } from '../roles/roleOverrideRecordV1.js';
import { SkillRuleV1Schema } from '../../reach/reachRuleV1.js';
import { reachRuleKeyV1 } from '../../reach/reachRulesChangeV1.js';
import { McpServerCatalogRowMutationV1Schema } from '../../mcp/servers/catalogSchemasV1.js';
import { SkillUsageRowV1Schema } from './skills/skillUsageV1.js';

export const PromptLibraryCatalogKeyV1Schema = lazyZodSchema(() => z.enum([
  'coding', 'voice', 'folders', 'invocations', 'external-links', 'registry-sources', 'contexts', 'role-overrides', 'skill-rules', 'skill-usage',
]));
export type PromptLibraryCatalogKeyV1 = z.infer<typeof PromptLibraryCatalogKeyV1Schema>;
export const PROMPT_LIBRARY_ACCOUNT_ROW_PREFIX_V1 = '@happier/account/prompt-library/v1/' as const;
export const PROMPT_LIBRARY_ROWS_ROUTE_V1 = '/v1/account/entity-rows/prompt-library' as const;
export const PROMPT_LIBRARY_ACCOUNT_CIPHER_KIND_V1 = 'account_prompt_catalog' as const;

export const PromptStackRecordV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1), scope: z.object({ kind: z.enum(['coding', 'voice']) }).strict(), entries: z.array(PromptStackEntryV1Schema),
}).strict());
export type PromptStackRecordV1 = z.infer<typeof PromptStackRecordV1Schema>;

export const SkillRulesRecordV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1), rules: z.array(SkillRuleV1Schema),
  consumedLegacyEntryIds: z.array(z.string().min(1)).optional(),
}).strict());
export type SkillRulesRecordV1 = z.infer<typeof SkillRulesRecordV1Schema>;

/** Each existing small domain has one row; Profile stacks remain Profile-owned. */
export const PromptLibraryRecordV1Schema = lazyZodSchema(() => z.discriminatedUnion('key', [
  z.object({ key: z.literal('coding'), value: PromptStackRecordV1Schema }).strict(),
  z.object({ key: z.literal('voice'), value: PromptStackRecordV1Schema }).strict(),
  z.object({ key: z.literal('folders'), value: PromptFoldersV1RecordSchema }).strict(),
  z.object({ key: z.literal('invocations'), value: z.object({ v: z.literal(1), entries: z.array(PromptInvocationEntryV1Schema.strict()) }).strict() }).strict(),
  z.object({ key: z.literal('external-links'), value: defineStoredReadProjection(
    z.object({ v: z.literal(1), links: z.array(PromptExternalLinkEntryV1Schema.strict()) }).strict()
      .transform(value => ({ ...value, links: value.links.map(({ syncMode: _syncMode, ...link }) => link) })),
    () => createStoredReadSchema(PromptExternalLinksV1Schema),
  ) }).strict(),
  z.object({ key: z.literal('registry-sources'), value: defineStoredReadProjection(RegistrySourcesRecordV1Schema,
    () => RegistrySourcesReadEnvelopeV1Schema.passthrough().transform((value, context) => {
      try { return readRegistrySourcesRecordV1(value); }
      catch {
        context.addIssue({ code: 'custom', message: 'Registry token reference inventory is incomplete' });
        return z.NEVER;
      }
    })) }).strict(),
  z.object({ key: z.literal('contexts'), value: z.object({ v: z.literal(1), selectionsByKey: z.record(z.string(), ContextSelectionV1Schema.strict()) }).strict() }).strict(),
  z.object({ key: z.literal('role-overrides'), value: RoleOverrideRecordV1Schema }).strict(),
  z.object({ key: z.literal('skill-rules'), value: SkillRulesRecordV1Schema }).strict(),
  z.object({ key: z.literal('skill-usage'), value: SkillUsageRowV1Schema }).strict(),
]).superRefine((record, context) => {
  if ((record.key === 'coding' || record.key === 'voice') && record.value.scope.kind !== record.key) {
    context.addIssue({ code: 'custom', path: ['value', 'scope', 'kind'], message: 'Stack scope must match its catalog address' });
  }
  if (record.key === 'skill-rules') {
    const seen = new Set<string>();
    for (const [index, rule] of record.value.rules.entries()) {
      const key = JSON.stringify([rule.skillId, reachRuleKeyV1(rule)]);
      if (seen.has(key)) context.addIssue({ code: 'custom', path: ['value', 'rules', index],
        message: 'Skill rules must be unique per item, place and Agent scope' });
      seen.add(key);
    }
  }
  const ids = record.key === 'coding' || record.key === 'voice' ? record.value.entries.map(entry => entry.id)
    : record.key === 'folders' ? record.value.folders.map(entry => entry.id)
    : record.key === 'invocations' ? record.value.entries.map(entry => entry.id)
    : record.key === 'external-links' ? record.value.links.map(entry => entry.id)
    : record.key === 'registry-sources' ? record.value.sources.map(entry => entry.id) : [];
  if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', path: ['value'], message: 'Catalog entry identities must be unique' });
}));
export type PromptLibraryRecordV1 = z.infer<typeof PromptLibraryRecordV1Schema>;
export const StoredPromptLibraryRecordV1Schema = createStoredReadSchema(PromptLibraryRecordV1Schema);

const plainContent = lazyZodSchema(() => z.object({ t: z.literal('plain'), v: PromptLibraryRecordV1Schema }).strict());
const encryptedContent = lazyZodSchema(() => z.object({ t: z.literal('encrypted'), c: z.string().min(1) }).strict());
export const PromptLibraryContentV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [plainContent, encryptedContent]));
export type PromptLibraryContentV1 = z.infer<typeof PromptLibraryContentV1Schema>;
export const StoredPromptLibraryContentV1Schema = createStoredReadSchema(PromptLibraryContentV1Schema);
// HTTP reads carry persisted records. Drop their additive fields before strict domain admission,
// while keeping the response, content discriminator and ciphertext envelopes closed.
const readContent = lazyZodSchema(() => z.discriminatedUnion('t', [
  plainContent.extend({ v: StoredPromptLibraryRecordV1Schema }), encryptedContent,
]));

const revision = lazyZodSchema(() => z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
export const PromptLibraryRowFailureV1Schema = lazyZodSchema(() => z.object({
  status: z.enum(['account-not-found', 'account-inconsistent', 'account-mode-mismatch', 'invalid-stored-content']), reason: z.string().optional(),
}).strict());
export const PromptLibraryRowReadResponseV1Schema = lazyZodSchema(() => z.union([
  z.object({ status: z.literal('present'), revision, content: readContent }).strict(),
  z.object({ status: z.literal('absent') }).strict(), z.object({ status: z.literal('deleted'), revision }).strict(), PromptLibraryRowFailureV1Schema,
]));
export const PromptLibraryRowMutationV1Schema = lazyZodSchema(() => z.object({
  expectedRevision: z.union([revision, z.literal('absent')]), content: PromptLibraryContentV1Schema.nullable(),
  sourceSettingsVersion: revision.optional(),
  referencedSavedSecretIds: McpServerCatalogRowMutationV1Schema.shape.referencedSavedSecretIds.unwrap().optional(),
  savedSecretRevisions: McpServerCatalogRowMutationV1Schema.shape.savedSecretRevisions.unwrap().optional(),
}).strict().superRefine((mutation, context) => {
  if (mutation.expectedRevision === 'absent' && (mutation.sourceSettingsVersion === undefined || mutation.content === null)) {
    context.addIssue({ code: 'custom', path: ['sourceSettingsVersion'], message: 'First destination authority requires captured source currentness' });
  }
  if (mutation.sourceSettingsVersion !== undefined && (mutation.expectedRevision !== 'absent' || mutation.content === null)) {
    context.addIssue({ code: 'custom', path: ['sourceSettingsVersion'], message: 'Source admission initializes destination authority only' });
  }
}));
export type PromptLibraryRowMutationV1 = z.infer<typeof PromptLibraryRowMutationV1Schema>;
export const PromptLibraryRowMutationResponseV1Schema = lazyZodSchema(() => z.union([
  z.object({ status: z.literal('updated'), revision, cursor: revision }).strict(),
  z.object({ status: z.literal('conflict'), revision: z.number().int().min(-1) }).strict(), PromptLibraryRowFailureV1Schema,
  z.object({ status: z.literal('settings-conflict'), revision }).strict(),
  z.object({ status: z.literal('invalid-reference') }).strict(),
]));
export const PromptLibraryRowsListResponseV1Schema = lazyZodSchema(() => z.union([
  z.object({ status: z.literal('listed'), rows: z.array(z.object({
    key: PromptLibraryCatalogKeyV1Schema, revision, content: readContent.nullable(),
  }).strict()) }).strict(), PromptLibraryRowFailureV1Schema,
]));
export const AccountEncryptionMigratePromptLibraryDirectiveV1Schema = lazyZodSchema(() => z.object({
  items: z.array(z.object({ key: PromptLibraryCatalogKeyV1Schema, expectedRevision: revision, content: PromptLibraryContentV1Schema }).strict()),
}).strict().superRefine((directive, context) => {
  const keys = new Set<string>();
  for (const [index, item] of directive.items.entries()) {
    if (keys.has(item.key) || (item.content.t === 'plain' && item.content.v.key !== item.key)) {
      context.addIssue({ code: 'custom', path: ['items', index, 'key'], message: 'Prompt catalog identity must be unique and match its content' });
    }
    keys.add(item.key);
  }
}));
export type AccountEncryptionMigratePromptLibraryDirectiveV1 = z.infer<typeof AccountEncryptionMigratePromptLibraryDirectiveV1Schema>;
export const AccountEncryptionMigratePromptLibraryResultV1Schema = lazyZodSchema(() => z.object({
  rows: z.array(z.object({ key: PromptLibraryCatalogKeyV1Schema, revision, content: PromptLibraryContentV1Schema.nullable() }).strict()),
}).strict());
export type AccountEncryptionMigratePromptLibraryResultV1 = z.infer<typeof AccountEncryptionMigratePromptLibraryResultV1Schema>;
