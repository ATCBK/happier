import { z } from 'zod';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { AgentIdV1Schema } from '../../../agents/agentIdV1.js';
import { ReachRulesChangeV1Schema } from '../../../reach/reachRulesChangeV1.js';
import { RegistryItemPointerV1Schema } from '../../../registries/registryItemsV1.js';
import { SkillCostV1Schema } from './skillCostV1.js';
import { SkillTrustV1Schema } from './skillTrustV1.js';
import { SkillListItemV1Schema, SkillProvenanceV1Schema, SkillRevisionV1Schema } from './skillLibraryItemV1.js';

export const SkillFileInputV1Schema = lazyZodSchema(() => z.object({ path: z.string().min(1), contentBase64: z.string(),
  contentKind: z.enum(['utf8', 'binary']), unixMode: z.number().int().min(0).max(0o7777).nullable().optional() }).strict());
export type SkillFileInputV1 = z.infer<typeof SkillFileInputV1Schema>;
export const SkillActionFailureResultV1Schema = lazyZodSchema(() => z.object({ ok: z.literal(false), code: z.string().min(1), current: SkillListItemV1Schema.optional() }).strict());
export type SkillActionFailureResultV1 = z.infer<typeof SkillActionFailureResultV1Schema>;
export const SkillFileChangeV1Schema = lazyZodSchema(() => z.union([
  z.object({ kind: z.literal('upsert'), file: SkillFileInputV1Schema }).strict(),
  z.object({ kind: z.literal('remove'), path: z.string().min(1) }).strict(),
]));
const skillId = lazyZodSchema(() => z.string().min(1));
const identity = lazyZodSchema(() => z.object({ skillId }).strict());
const createResult = lazyZodSchema(() => z.object({ ok: z.literal(true), skillId, revision: SkillRevisionV1Schema,
  includedInSessionId: z.string().nullable(), incomplete: z.enum(['rules', 'session_include']).optional() }).strict());
const batchCreateResult = lazyZodSchema(() => z.object({ skillIds: z.array(skillId), includedInSessionId: z.string().nullable(),
  incomplete: z.array(z.object({ skillId, step: z.enum(['rules', 'session_include']) }).strict()).optional() }).strict());
export const SkillInstallPreviewV1Schema = lazyZodSchema(() => z.object({ path: z.string(), name: z.string(), description: z.string().nullable(),
  files: z.array(SkillFileInputV1Schema), trust: SkillTrustV1Schema, cost: SkillCostV1Schema, provenance: SkillProvenanceV1Schema }).strict());
export const SkillInstallSourceV1Schema = lazyZodSchema(() => z.union([
  RegistryItemPointerV1Schema.extend({ kind: z.literal('registry') }).strict(),
  z.object({ kind: z.literal('link'), url: z.string().url() }).strict(),
  z.object({ kind: z.literal('upload'), files: z.array(SkillFileInputV1Schema) }).strict(),
]));
const changeResult = lazyZodSchema(() => z.object({ revision: SkillRevisionV1Schema }).strict());
export const SkillUpdateFileV1Schema = lazyZodSchema(() => z.object({ path: z.string(), mine: SkillFileInputV1Schema.nullable(),
  theirs: SkillFileInputV1Schema.nullable(), changed: z.boolean() }).strict());
export const SKILL_ACTION_INPUT_SCHEMAS_V1 = {
  'skills.list': lazyZodSchema(() => z.object({ query: z.string().optional(), state: z.enum(['in_use', 'off', 'updates', 'needs_attention']).optional() }).strict()),
  'skills.create': lazyZodSchema(() => z.object({ name: z.string().min(1), description: z.string().optional(), files: z.array(SkillFileInputV1Schema), where: ReachRulesChangeV1Schema.optional() }).strict()),
  'skills.update': lazyZodSchema(() => z.object({ skillId, expectedRevision: SkillRevisionV1Schema, name: z.string().optional(), description: z.string().optional(), files: z.array(SkillFileChangeV1Schema).optional(), updatePolicy: z.enum(['manual', 'auto', 'pinned']).optional() }).strict()),
  'skills.duplicate': identity,
  'skills.delete': lazyZodSchema(() => z.object({ skillId, expectedRevision: SkillRevisionV1Schema }).strict()),
  'skills.install': lazyZodSchema(() => z.object({ source: SkillInstallSourceV1Schema, selectPaths: z.array(z.string()).optional(), where: ReachRulesChangeV1Schema.optional(), dryRun: z.boolean().optional() }).strict()),
  'skills.found.adopt': lazyZodSchema(() => z.object({ machineId: z.string().min(1),
    items: z.array(z.object({ name: z.string().min(1), path: z.string().min(1) }).strict()).min(1), where: ReachRulesChangeV1Schema.optional() }).strict()),
  'skills.found.read': lazyZodSchema(() => z.object({ machineId: z.string().min(1), path: z.string().min(1) }).strict()),
  'skills.export': lazyZodSchema(() => z.object({ skillIds: z.array(skillId).min(1) }).strict()),
  'skills.updates.diff': identity,
  'skills.updates.apply': lazyZodSchema(() => z.object({ skillId, expectedRevision: SkillRevisionV1Schema, choices: z.record(z.string(), z.enum(['mine', 'theirs'])).optional() }).strict()),
} as const;
export const SKILL_ACTION_OUTPUT_SCHEMAS_V1 = {
  'skills.list': lazyZodSchema(() => z.object({ items: z.array(SkillListItemV1Schema), revision: z.string(),
    usageObservedSince: z.number().int().nonnegative().safe().nullable().optional() }).strict()),
  'skills.create': createResult, 'skills.update': changeResult, 'skills.duplicate': createResult,
  'skills.delete': lazyZodSchema(() => z.object({ deleted: z.literal(true), rulesLeft: z.literal(true).optional() }).strict()),
  'skills.install': lazyZodSchema(() => z.union([
    z.object({ items: z.array(SkillInstallPreviewV1Schema) }).strict(),
    batchCreateResult,
  ])),
  'skills.found.adopt': batchCreateResult,
  'skills.found.read': lazyZodSchema(() => z.object({ name: z.string().min(1), files: z.array(SkillFileInputV1Schema) }).strict()),
  'skills.export': lazyZodSchema(() => z.object({ fileName: z.string(), bytes: z.string() }).strict()),
  'skills.updates.diff': lazyZodSchema(() => z.object({ files: z.array(SkillUpdateFileV1Schema), costDelta: z.object({ mine: SkillCostV1Schema, theirs: SkillCostV1Schema }).strict() }).strict()),
  'skills.updates.apply': lazyZodSchema(() => z.object({ revision: SkillRevisionV1Schema, provenance: SkillProvenanceV1Schema }).strict()),
} as const;
export type SkillLibraryActionIdV1 = keyof typeof SKILL_ACTION_INPUT_SCHEMAS_V1;
export type SkillLibraryActionInputByIdV1 = { readonly [K in SkillLibraryActionIdV1]: z.infer<(typeof SKILL_ACTION_INPUT_SCHEMAS_V1)[K]> };
export type SkillLibraryActionResultByIdV1 = { readonly [K in SkillLibraryActionIdV1]: z.infer<(typeof SKILL_ACTION_OUTPUT_SCHEMAS_V1)[K]> };

export const SkillFoundListInputV1Schema = lazyZodSchema(() => z.object({
  machineId: z.string().min(1), directory: z.string().min(1).optional(),
}).strict());
export const SkillFoundListResultV1Schema = lazyZodSchema(() => z.object({
  scannedAt: z.number().int().min(0),
  roots: z.array(z.object({
    path: z.string().min(1), scope: z.enum(['user', 'project', 'plugin']),
    agents: z.array(AgentIdV1Schema), status: z.enum(['ok', 'failed']),
  }).strict()),
  items: z.array(z.object({
    name: z.string().min(1), description: z.string().nullable(),
    // Found and download both identify the skill directory, never its SKILL.md.
    path: z.string().min(1), digest: z.string().min(1), agents: z.array(AgentIdV1Schema),
    scope: z.enum(['user', 'project', 'plugin']), inLibrary: skillId.nullable(),
    masksLibrary: z.boolean(), happierInstalled: z.boolean(),
    pluginOwned: z.object({ pluginName: z.string().min(1) }).strict().nullable(),
  }).strict()),
}).strict());
export type SkillFoundListInputV1 = z.infer<typeof SkillFoundListInputV1Schema>;
export type SkillFoundListResultV1 = z.infer<typeof SkillFoundListResultV1Schema>;

export const SkillMachineInstallInputV1Schema = lazyZodSchema(() => z.object({
  skillId, machineId: z.string().min(1), agents: z.array(AgentIdV1Schema).optional(),
}).strict());
export const SkillMachineInstallResultV1Schema = lazyZodSchema(() => z.object({
  receipts: z.array(z.object({ root: z.string().min(1), path: z.string().min(1), digest: z.string().min(1) }).strict()),
}).strict());
export type SkillMachineInstallInputV1 = z.infer<typeof SkillMachineInstallInputV1Schema>;
export type SkillMachineInstallResultV1 = z.infer<typeof SkillMachineInstallResultV1Schema>;
export const SkillMachineUninstallInputV1Schema = lazyZodSchema(() => z.object({
  skillId, machineId: z.string().min(1), force: z.boolean().optional(),
}).strict());
export const SkillMachineUninstallResultV1Schema = lazyZodSchema(() => z.object({ removed: z.array(z.string().min(1)) }).strict());
export type SkillMachineUninstallInputV1 = z.infer<typeof SkillMachineUninstallInputV1Schema>;
export type SkillMachineUninstallResultV1 = z.infer<typeof SkillMachineUninstallResultV1Schema>;

// Machine handlers consume these shapes; the Account library dispatcher stays closed.
export const SKILL_MACHINE_ACTION_INPUT_SCHEMAS_V1 = {
  'skills.found.list': SkillFoundListInputV1Schema,
  'skills.machine.install': SkillMachineInstallInputV1Schema,
  'skills.machine.uninstall': SkillMachineUninstallInputV1Schema,
} as const;
export const SKILL_MACHINE_ACTION_OUTPUT_SCHEMAS_V1 = {
  'skills.found.list': SkillFoundListResultV1Schema,
  'skills.machine.install': SkillMachineInstallResultV1Schema,
  'skills.machine.uninstall': SkillMachineUninstallResultV1Schema,
} as const;
export type SkillMachineActionIdV1 = keyof typeof SKILL_MACHINE_ACTION_INPUT_SCHEMAS_V1;
export type SkillMachineActionInputByIdV1 = { readonly [K in SkillMachineActionIdV1]: z.infer<(typeof SKILL_MACHINE_ACTION_INPUT_SCHEMAS_V1)[K]> };
export type SkillMachineActionResultByIdV1 = { readonly [K in SkillMachineActionIdV1]: z.infer<(typeof SKILL_MACHINE_ACTION_OUTPUT_SCHEMAS_V1)[K]> };

/** Actual content acknowledgements carried by the existing outer Action failure envelope. */
export const SkillInstallAcknowledgedEffectsV1Schema = lazyZodSchema(() => z.object({
  skillIds: z.array(skillId),
  incomplete: z.array(z.object({ skillId, step: z.enum(['rules', 'session_include']) }).strict()),
}).strict());
export type SkillInstallAcknowledgedEffectsV1 = z.infer<typeof SkillInstallAcknowledgedEffectsV1Schema>;
