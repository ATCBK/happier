import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { DaemonLocalServiceLauncherStartRequestV1Schema, DaemonLocalServiceLauncherStartResponseV1Schema } from '../../local/services/launcher/v1.js';

// New Machine Processes wire epoch V1. Process envelopes and identity/ownership
// facts are closed. The optional launcher review uses its existing canonical
// schema, including its explicitly declared strict-JSON effect payload.
const id = () => z.string().min(1);
const bytes = () => z.number().finite().nonnegative();
const target = () => ({ serverId: id().optional(), machineId: id() });
export const ProcessOwnerRefV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('session'), sessionId: id() }),
  z.strictObject({ kind: z.literal('terminal'), terminalId: id(), sessionId: id().optional() }),
  z.strictObject({ kind: z.literal('service'), serviceId: id(), pluginId: id().optional(), sessionId: id().optional(), workspaceId: id().optional() }),
  z.strictObject({ kind: z.literal('run'), runId: id(), sessionId: id().optional() }),
  z.strictObject({ kind: z.literal('browser_sidecar') }),
  z.strictObject({ kind: z.literal('workspace_sync') }),
  z.strictObject({ kind: z.literal('happier'), component: z.enum(['voice_worker', 'device_helper', 'recording_encoder', 'plugin_database_worker', 'workspace_sync']).optional() }),
]));
export type ProcessOwnerRefV1 = z.infer<typeof ProcessOwnerRefV1Schema>;
export const ProcessOwnershipLevelV1Schema = lazyZodSchema(() => z.enum(['proven', 'likely', 'left_behind', 'not_happier', 'unknown']));
export type ProcessOwnershipLevelV1 = z.infer<typeof ProcessOwnershipLevelV1Schema>;
export const ProcessEvidenceV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.enum(['fence', 'parent_chain', 'marker', 'group_and_port']),
  state: z.enum(['met', 'not_met', 'not_available']),
  reason: z.enum(['linux_scope', 'windows_job', 'macos_no_fence', 'no_systemd_user_manager', 'job_join_failed',
    'outside_fence', 'live_root_chain', 'chain_broken_at_exit', 'no_live_root', 'marker_matches', 'marker_cleared',
    'foreign_home_marker', 'marker_owner_unknown', 'marker_predates_owner', 'same_group_port_opened_while_running',
    'no_group_or_port_match', 'principal_unreadable', 'other_principal', 'required_fields_unreadable']),
  at: z.strictObject({ pid: z.number().int().positive(), exitedAtMs: bytes().optional() }).optional(),
}));
export type ProcessEvidenceV1 = z.infer<typeof ProcessEvidenceV1Schema>;
export const MachineProcessesTotalsV1Schema = lazyZodSchema(() => z.strictObject({
  memoryBytes: bytes().nullable(), cpuPercent: bytes().max(100).optional(), processCount: z.number().int().nonnegative(),
}));
export type MachineProcessesTotalsV1 = z.infer<typeof MachineProcessesTotalsV1Schema>;
export const ProcessSampleV1Schema = lazyZodSchema(() => z.strictObject({
  capturedAtMs: bytes(), memoryBytes: bytes().nullable(), cpuPercent: bytes().max(100).nullable().optional(),
}));
export type ProcessSampleV1 = z.infer<typeof ProcessSampleV1Schema>;
export const ProcessRowV1Schema = lazyZodSchema(() => z.strictObject({
  rowId: id(), ref: id(), parentRowId: id().optional(), name: id(),
  role: z.enum(['agent', 'tool_shell', 'test_runner', 'type_checker', 'dev_server', 'language_server', 'mcp_server', 'browser', 'database']).optional(),
  browserEngine: z.enum(['chromium', 'firefox', 'webkit']).optional(), browserHelper: z.boolean().optional(),
  driverLabel: z.string().optional(),
  // Presentation only: child refs retain individual identity/Action semantics.
  browserGroup: z.strictObject({ memberRefs: z.array(id()), totals: MachineProcessesTotalsV1Schema }).optional(),
  command: z.string().optional(), cwd: z.string().optional(), pid: z.number().int().positive(), startedAtMs: bytes(),
  memoryBytes: bytes().nullable(), memoryKind: z.enum(['rss', 'footprint', 'private', 'working_set']).nullable(),
  cpuPercent: bytes().max(100).optional(),
  ports: z.array(z.strictObject({ port: z.number().int().min(1).max(65535), inventoryEntryId: id() })).optional(),
  level: z.enum(['proven', 'likely', 'left_behind', 'unknown']),
  evidence: z.array(ProcessEvidenceV1Schema).optional(),
  chain: z.array(z.strictObject({ pid: z.number().int().positive(), name: id(), exitedAtMs: bytes().optional() })).optional(),
  principalName: z.string().optional(),
}));
export type ProcessRowV1 = z.infer<typeof ProcessRowV1Schema>;
export const OwnerRowV1Schema = lazyZodSchema(() => z.strictObject({
  rowId: id(), owner: ProcessOwnerRefV1Schema, state: z.enum(['running', 'stopping', 'stopped']),
  totals: MachineProcessesTotalsV1Schema, members: z.array(ProcessRowV1Schema),
  requester: z.strictObject({ accountId: id(), displayName: z.string() }).optional(),
  ceiling: z.strictObject({ limitBytes: bytes().positive(), usedBytes: bytes().optional(), observedAtMs: bytes().optional(),
    throttleCount5m: z.number().int().nonnegative().optional() }).optional(),
}));
export type OwnerRowV1 = z.infer<typeof OwnerRowV1Schema>;
export const LeftBehindRowV1Schema = lazyZodSchema(() => ProcessRowV1Schema.extend({
  level: z.literal('left_behind'), owner: ProcessOwnerRefV1Schema, confirmedAtMs: bytes(),
}));
export type LeftBehindRowV1 = z.infer<typeof LeftBehindRowV1Schema>;
// Deliberately distinct: non-Happier rows cannot transport commands, cwd, tags,
// evidence, or a claimed Happier owner even in a detail response.
export const NotHappierRowV1Schema = lazyZodSchema(() => z.strictObject({
  name: id(), appGroup: id(), memoryBytes: bytes().nullable(), cpuPercent: bytes().max(100).optional(),
  pid: z.number().int().positive(), ref: id(),
}));
export type NotHappierRowV1 = z.infer<typeof NotHappierRowV1Schema>;
export const AppGroupRowV1Schema = lazyZodSchema(() => z.strictObject({ appGroup: id(), members: z.array(NotHappierRowV1Schema) }));
export type AppGroupRowV1 = z.infer<typeof AppGroupRowV1Schema>;
export const MachineProcessesAnswerV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), machineId: id(), capturedAtMs: bytes(), state: z.enum(['live', 'unavailable']),
  reason: z.enum(['helper_missing', 'read_failed', 'self_absent', 'unsupported_platform', 'all_processes_disabled', 'permission_denied']).optional(),
  platform: z.enum(['linux', 'darwin', 'win32']), evidenceModel: z.enum(['fenced', 'tree_and_marker']),
  owners: z.array(OwnerRowV1Schema), leftBehind: z.array(LeftBehindRowV1Schema), notHappier: z.array(AppGroupRowV1Schema).optional(),
  otherPrincipals: z.strictObject({ count: z.number().int().nonnegative(), memoryBytes: bytes().nullable(), cpuPercent: bytes().max(100).optional(), names: z.array(z.string()) }).optional(),
  othersWork: z.strictObject({ count: z.number().int().nonnegative() }).optional(),
  // Count only; unverifiable ownership never supplies a process Action target.
  unverifiableCount: z.number().int().nonnegative().optional(),
  totals: z.strictObject({ happier: MachineProcessesTotalsV1Schema, leftBehind: MachineProcessesTotalsV1Schema }),
  history: z.record(id(), z.array(ProcessSampleV1Schema)).optional(),
}));
export type MachineProcessesAnswerV1 = z.infer<typeof MachineProcessesAnswerV1Schema>;
export const MachineProcessesListInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...target(), scope: z.enum(['happier', 'all']).optional(), view: z.enum(['tree', 'owners']).optional(), sessionId: id().optional(), query: z.string().optional(),
}));
export type MachineProcessesListInputV1 = z.infer<typeof MachineProcessesListInputV1Schema>;
export const MachineProcessesWatchInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...target(), scope: z.enum(['happier', 'all']), view: z.enum(['tree', 'owners']), since: bytes().optional(), detailToken: id().optional(),
}));
export type MachineProcessesWatchInputV1 = z.infer<typeof MachineProcessesWatchInputV1Schema>;
export const MachineProcessesWatchResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('changed', [
  z.strictObject({ changed: z.literal(false) }), z.strictObject({ changed: z.literal(true), answer: MachineProcessesAnswerV1Schema }),
]));
export type MachineProcessesWatchResultV1 = z.infer<typeof MachineProcessesWatchResultV1Schema>;
export const MachineProcessesGetInputV1Schema = lazyZodSchema(() => z.strictObject({ ...target(), ref: id() }));
export type MachineProcessesGetInputV1 = z.infer<typeof MachineProcessesGetInputV1Schema>;
export const MachineProcessesGetResultV1Schema = lazyZodSchema(() => z.strictObject({
  row: z.union([ProcessRowV1Schema, NotHappierRowV1Schema]).nullable(), owner: ProcessOwnerRefV1Schema.optional(), history: z.array(ProcessSampleV1Schema).optional(),
}));
export type MachineProcessesGetResultV1 = z.infer<typeof MachineProcessesGetResultV1Schema>;
export const MachineProcessExpectationV1Schema = lazyZodSchema(() => z.strictObject({
  level: ProcessOwnershipLevelV1Schema, owner: ProcessOwnerRefV1Schema.optional(),
}));
export type MachineProcessExpectationV1 = z.infer<typeof MachineProcessExpectationV1Schema>;
export const MachineProcessTargetV1Schema = lazyZodSchema(() => z.strictObject({ ref: id(), expect: MachineProcessExpectationV1Schema }));
export type MachineProcessTargetV1 = z.infer<typeof MachineProcessTargetV1Schema>;
const uniqueRefs = (refs: readonly string[]) => new Set(refs).size === refs.length;
const refs = () => z.array(id()).min(1).refine(uniqueRefs, 'Process refs must be distinct');
const targets = () => z.array(MachineProcessTargetV1Schema).min(1).refine(items => uniqueRefs(items.map(item => item.ref)), 'Process refs must be distinct');
export const MachineProcessesCheckInputV1Schema = lazyZodSchema(() => z.strictObject({ ...target(), refs: refs() }));
export type MachineProcessesCheckInputV1 = z.infer<typeof MachineProcessesCheckInputV1Schema>;
export const MachineProcessesCheckResultV1Schema = lazyZodSchema(() => z.strictObject({ checks: z.array(z.strictObject({
  ref: id(), present: z.boolean(), identityEqual: z.boolean(), level: ProcessOwnershipLevelV1Schema.optional(), owner: ProcessOwnerRefV1Schema.nullable().optional(), memoryBytes: bytes().nullable().optional(),
})) }));
export type MachineProcessesCheckResultV1 = z.infer<typeof MachineProcessesCheckResultV1Schema>;
export const MachineProcessesStopInputV1Schema = lazyZodSchema(() => z.strictObject({ ...target(), targets: targets() }));
export type MachineProcessesStopInputV1 = z.infer<typeof MachineProcessesStopInputV1Schema>;
export const MachineProcessesKillInputV1Schema = lazyZodSchema(() => z.strictObject({ ...target(), targets: targets(), tree: z.boolean() }));
export type MachineProcessesKillInputV1 = z.infer<typeof MachineProcessesKillInputV1Schema>;
export const MachineProcessesActionResultV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.enum(['ended', 'partial', 'refused', 'failed']), outcomes: z.array(z.strictObject({
    ref: id(), outcome: z.enum(['ended', 'survived', 'gone_before', 'refused']), reasonCode: id().optional(), freedBytes: bytes().optional(),
  })),
}));
export type MachineProcessesActionResultV1 = z.infer<typeof MachineProcessesActionResultV1Schema>;
export const MachineProcessesCleanUpInputV1Schema = lazyZodSchema(() => z.strictObject({ ...target(), refs: refs() }));
export type MachineProcessesCleanUpInputV1 = z.infer<typeof MachineProcessesCleanUpInputV1Schema>;
export const MachineProcessesCleanUpResultV1Schema = lazyZodSchema(() => z.strictObject({
  ended: z.array(z.strictObject({ ref: id(), freedBytes: bytes() })), skipped: z.array(z.strictObject({ ref: id(), reason: id() })),
}));
export type MachineProcessesCleanUpResultV1 = z.infer<typeof MachineProcessesCleanUpResultV1Schema>;
export const MachineProcessesStartAgainInputV1Schema = lazyZodSchema(() => z.strictObject({ ...target(), ref: id() }));
export type MachineProcessesStartAgainInputV1 = z.infer<typeof MachineProcessesStartAgainInputV1Schema>;
export const MachineProcessesStartAgainResultV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.enum(['started', 'already_wakes_on_next_message', 'refused', 'failed']), reasonCode: id().optional(),
  // Carry the original launcher's declaration review into its existing review flow.
  // The canonical launcher schemas retain authority over requests and effect payloads.
  serviceStart: z.strictObject({
    request: DaemonLocalServiceLauncherStartRequestV1Schema,
    response: DaemonLocalServiceLauncherStartResponseV1Schema,
  }).superRefine(({ request, response }, ctx) => {
    if (request.machineId !== response.machineId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['response', 'machineId'], message: 'Launcher response must match the original request Machine.' });
    if (request.targetId !== response.targetId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['response', 'targetId'], message: 'Launcher response must match the original request target.' });
  }).optional(),
}));
export type MachineProcessesStartAgainResultV1 = z.infer<typeof MachineProcessesStartAgainResultV1Schema>;
