import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';
import { MachineVitalsAlertsPolicyV1Schema, MachineVitalsAlertsPolicyPatchV1Schema } from '../vitals/machineVitalsAlertsV1.js';
import { MachineStoragePolicyV1Schema, MachineStoragePolicyPatchV1Schema } from '../../storage/storageV1.js';
import { MachineGuardPolicyV1Schema, MachineGuardPolicyPatchV1Schema, mergeMachineGuardPolicyV1 } from '../guard/guardPolicyV1.js';
import { getMachineMetadataFieldV1, readMachineMetadataFieldV1, readMachineMetadataSnapshotV1, mutateMachineMetadataFieldV1,
  type MachineMetadataFieldPortV1 } from '../machineMetadataFieldV1.js';

export const MachineProcessesPolicyV1Schema = lazyZodSchema(() => z.object({
  allProcessesVisible: z.boolean().default(false),
  toolIdleCloseMs: z.number().int().min(1_000).max(Number.MAX_SAFE_INTEGER).nullable().default(300_000),
  // null uses the launch owner's RAM-derived admission; custom counts have only
  // the numeric representation boundary, not Auto's four-engine maximum.
  browserMaxConcurrent: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable().default(null),
}).strict());
export type MachineProcessesPolicyV1 = z.infer<typeof MachineProcessesPolicyV1Schema>;
export const MachineProcessesPolicyPatchV1Schema = lazyZodSchema(() => z.object({
  allProcessesVisible: MachineProcessesPolicyV1Schema.shape.allProcessesVisible.removeDefault().optional(),
  toolIdleCloseMs: MachineProcessesPolicyV1Schema.shape.toolIdleCloseMs.removeDefault().optional(),
  browserMaxConcurrent: MachineProcessesPolicyV1Schema.shape.browserMaxConcurrent.removeDefault().optional(),
}).strict());

export const MachineResourcesPolicyV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1), alerts: MachineVitalsAlertsPolicyV1Schema.default(() => MachineVitalsAlertsPolicyV1Schema.parse({})),
  processes: MachineProcessesPolicyV1Schema.default(() => MachineProcessesPolicyV1Schema.parse({})),
  storage: MachineStoragePolicyV1Schema.default(() => MachineStoragePolicyV1Schema.parse({})),
  guard: MachineGuardPolicyV1Schema.default(() => MachineGuardPolicyV1Schema.parse({})),
}).strict());
export type MachineResourcesPolicyV1 = z.infer<typeof MachineResourcesPolicyV1Schema>;
export const MachineResourcesPolicyV1StoredSchema = createStoredReadSchema(MachineResourcesPolicyV1Schema);
export const MachineResourcesPolicyPatchV1Schema = lazyZodSchema(() => z.object({ alerts: MachineVitalsAlertsPolicyPatchV1Schema.optional(),
  processes: MachineProcessesPolicyPatchV1Schema.optional(),
  storage: MachineStoragePolicyPatchV1Schema.optional(),
  guard: MachineGuardPolicyPatchV1Schema.optional(),
}).strict());
export type MachineResourcesPolicyPatchV1 = z.infer<typeof MachineResourcesPolicyPatchV1Schema>;
export const MachineResourcesPolicyMutationV1Schema = lazyZodSchema(() => z.object({
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), patch: MachineResourcesPolicyPatchV1Schema,
}).strict());
export const MachineResourcesPolicyGetResultV1Schema = lazyZodSchema(() => z.union([
  z.object({ status: z.literal('ready'), policy: MachineResourcesPolicyV1Schema, revision: z.number().int().nonnegative(), source: z.enum(['stored', 'default']) }).strict(),
  z.object({ status: z.enum(['locked', 'invalid', 'unavailable']) }).strict(),
]));
export type MachineResourcesPolicyGetResultV1 = z.infer<typeof MachineResourcesPolicyGetResultV1Schema>;
export const MachineResourcesPolicyMutationResultV1Schema = lazyZodSchema(() => z.union([
  z.object({ status: z.enum(['applied', 'unchanged', 'conflict']), policy: MachineResourcesPolicyV1Schema, revision: z.number().int().nonnegative() }).strict(),
  z.object({ status: z.enum(['unavailable', 'unsupported']), reason: z.string().min(1) }).strict(),
]));
export type MachineResourcesPolicyMutationResultV1 = z.infer<typeof MachineResourcesPolicyMutationResultV1Schema>;
const definition = { field: 'resourcesPolicyV1', storedSchema: MachineResourcesPolicyV1StoredSchema,
  defaultValue: (): MachineResourcesPolicyV1 => MachineResourcesPolicyV1Schema.parse({ v: 1 }), equal: sameStrictJsonValue };
export function readMachineResourcesPolicyV1(metadata: unknown) { return readMachineMetadataFieldV1(metadata, definition); }
export function readMachineResourcesPolicyV1SnapshotFromMetadata(input: Readonly<{ metadata: unknown; metadataVersion: number; hasContentKey: boolean }>): MachineResourcesPolicyGetResultV1 {
  if (!input.hasContentKey) return { status: 'locked' };
  if (!Number.isSafeInteger(input.metadataVersion) || input.metadataVersion < 0) return { status: 'invalid' };
  const result = readMachineResourcesPolicyV1(input.metadata);
  return result.status === 'ready' ? { ...result, revision: input.metadataVersion } : result;
}
export async function getMachineResourcesPolicyV1(port: MachineMetadataFieldPortV1): Promise<MachineResourcesPolicyGetResultV1> {
  const result = await getMachineMetadataFieldV1(port, definition);
  if (result.status !== 'ready') return result;
  const { metadataVersion, ...snapshot } = result;
  return { ...snapshot, revision: metadataVersion };
}
export async function mutateMachineResourcesPolicyV1(input: unknown, port: MachineMetadataFieldPortV1, options?: Readonly<{ signal?: AbortSignal }>): Promise<MachineResourcesPolicyMutationResultV1> {
  const parsed = MachineResourcesPolicyMutationV1Schema.safeParse(input);
  if (!parsed.success) return { status: 'unavailable', reason: 'invalid_policy_patch' };
  const snapshot = await readMachineMetadataSnapshotV1(port);
  if (snapshot.status !== 'ready') return { status: 'unavailable', reason: snapshot.status };
  const current = readMachineResourcesPolicyV1(snapshot.metadata);
  if (current.status !== 'ready') return { status: 'unavailable', reason: current.status };
  const patch = parsed.data.patch.alerts;
  const merged = MachineResourcesPolicyV1Schema.safeParse({ ...current.policy,
    processes: { ...current.policy.processes, ...parsed.data.patch.processes },
    storage: { ...current.policy.storage, ...parsed.data.patch.storage },
    guard: mergeMachineGuardPolicyV1(current.policy.guard, parsed.data.patch.guard), alerts: {
    memory: { ...current.policy.alerts.memory, ...patch?.memory }, cpu: { ...current.policy.alerts.cpu, ...patch?.cpu },
    disk: { ...current.policy.alerts.disk, ...patch?.disk },
  } });
  if (!merged.success) return { status: 'unavailable', reason: 'invalid_policy_patch' };
  const policy = merged.data;
  let initialRead = true;
  const result = await mutateMachineMetadataFieldV1({ expectedMetadataVersion: parsed.data.expectedRevision, expectedPolicy: current.policy, policy, comparison: 'revision' },
    { ...port, read: async () => { if (!initialRead) return port.read(); initialRead = false; return snapshot; } }, definition, options);
  if (result.status === 'applied' || result.status === 'satisfied' || result.status === 'unchanged' || result.status === 'conflict') {
    return { status: result.status === 'satisfied' ? 'applied' : result.status, policy: result.policy, revision: result.metadataVersion };
  }
  return { status: 'unavailable', reason: result.status };
}
