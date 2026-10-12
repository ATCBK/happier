import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import type { PreNormalizedActionSpec } from './actionSpecs.js';
import { InstallableCapabilityIdSchema } from '../installables/descriptor.js';

export const UPDATES_ACTION_IDS = ['updates.get', 'machines.cli.update', 'updates.check', 'updates.batch.start', 'updates.batch.stop'] as const;
export type UpdatesActionId = typeof UPDATES_ACTION_IDS[number];
export function isUpdatesActionId(value: string): value is UpdatesActionId {
  return (UPDATES_ACTION_IDS as readonly string[]).includes(value);
}
const id = z.string().trim().min(1);
const EmptyInputSchema = lazyZodSchema(() => z.object({}).strict());
export const UpdateItemStateSchema = lazyZodSchema(() => z.enum([
  'unchecked', 'checking', 'upToDate', 'available', 'required', 'running', 'ready', 'failed', 'unknown', 'offline',
]));
export type UpdateItemState = z.infer<typeof UpdateItemStateSchema>;
export const UpdateItemActionVerbSchema = lazyZodSchema(() => z.enum(['update', 'retry', 'restart', 'reload', 'store']));
export type UpdateItemActionVerb = z.infer<typeof UpdateItemActionVerbSchema>;
export const UpdateSubjectSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('app') }).strict(), z.object({ kind: z.literal('happier-cli') }).strict(),
  z.object({ kind: z.literal('agent-cli'), agentId: id }).strict(),
  z.object({ kind: z.literal('installable'), key: id }).strict(),
]));
export type UpdateSubject = Readonly<z.infer<typeof UpdateSubjectSchema>>;
export const UpdatesActionInputSchemas = {
  'updates.get': EmptyInputSchema,
  'machines.cli.update': lazyZodSchema(() => z.object({ target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('local') }).strict(),
    z.object({ kind: z.literal('machine'), machineId: id }).strict(),
  ]) }).strict()),
  'updates.check': EmptyInputSchema,
  'updates.batch.start': lazyZodSchema(() => z.object({ groupId: id.nullable(), itemIds: z.array(id).min(1)
    .refine(items => new Set(items).size === items.length) }).strict()),
  'updates.batch.stop': EmptyInputSchema,
} as const;
const OperationResultSchema = lazyZodSchema(() => z.object({ status: z.literal('requested') }).strict());
export const UpdatesSnapshotResultSchema = lazyZodSchema(() => z.object({
  groups: z.array(z.object({
    groupId: id, machineName: z.string().nullable(), online: z.boolean(),
    target: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('app') }).strict(), z.object({ kind: z.literal('local') }).strict(),
      z.object({ kind: z.literal('machine'), machineId: id }).strict(),
    ]),
    items: z.array(z.object({
      itemId: id, title: z.string(), subject: UpdateSubjectSchema, state: UpdateItemStateSchema,
      currentVersion: z.string().nullable(), latestVersion: z.string().nullable(),
      managedBy: z.enum(['happier', 'user']), action: UpdateItemActionVerbSchema.nullable(), batchEligible: z.boolean(),
      capabilityId: InstallableCapabilityIdSchema.nullable(), manualCommand: z.string().nullable(), logPath: z.string().nullable(),
    }).strict()),
  }).strict()),
  batch: z.object({ done: z.number().int().nonnegative(), total: z.number().int().nonnegative(), stopping: z.boolean() }).strict().nullable(),
}).strict());
export const UpdatesActionOutputSchemas = {
  'updates.get': UpdatesSnapshotResultSchema,
  'machines.cli.update': OperationResultSchema, 'updates.check': OperationResultSchema,
  'updates.batch.start': OperationResultSchema, 'updates.batch.stop': OperationResultSchema,
} as const;
export const UPDATES_ACTION_SPECS = UPDATES_ACTION_IDS.map((actionId): PreNormalizedActionSpec => ({
  id: actionId, approval: { result: 'required' }, approvalPolicy: { uiConfirmation: 'policy' }, title: {
    'updates.get': 'Get current update targets',
    'machines.cli.update': 'Update managed Happier CLI', 'updates.check': 'Check for updates',
    'updates.batch.start': 'Update selected items', 'updates.batch.stop': 'Stop after current updates',
  }[actionId],
  description: actionId === 'updates.batch.stop'
    ? 'Stops the current Account’s existing Updates batch after its current item; closing the Updates detail surface does not prevent Stop.'
    : 'Requires the answering app’s Updates detail surface to be mounted. Read updates.get for exact group/item ids and supported targets; an unavailable owner returns a typed refusal. Updates install latest through existing owners; displayed versions and manual commands never authorize another updater recipe.',
  safety: actionId === 'machines.cli.update' || actionId === 'updates.batch.start' ? 'danger' : 'safe',
  sideEffectClass: actionId === 'updates.get' ? 'read' : actionId === 'machines.cli.update' || actionId === 'updates.batch.start' ? 'danger' : 'write',
  requiredAuthority: 'account_automation', executionPlacement: 'client', placements: [],
  bindings: { mcpToolName: actionId.replace(/[.]/g, '_') },
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: false, rpc: false },
  toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
  inputSchema: UpdatesActionInputSchemas[actionId], outputSchema: UpdatesActionOutputSchemas[actionId],
  inputHints: { fields: [] },
}));
