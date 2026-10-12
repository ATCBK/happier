import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import { InstallableCapabilityIdSchema } from '../../installables/descriptor.js';
export { MachineTerminalOpenInputSchema, MachineTerminalListInputSchema } from './machineTerminal.js';

const id = z.string().trim().min(1);
export const MACHINE_PAGE_ACTION_IDS = ['machines.metadata.update', 'machines.daemon.stop', 'machines.remove', 'machines.capabilities.install', 'machines.replacement.set', 'machines.replacement.clear'] as const;
export type MachinePageActionId = typeof MACHINE_PAGE_ACTION_IDS[number];
const machineTarget = { serverId: id.optional(), machineId: id };
export const MachineMetadataUpdateInputSchema = lazyZodSchema(() => z.object({
  ...machineTarget,
  expectedVersion: z.number().int().nonnegative().optional(),
  patch: z.object({
    displayName: z.string().nullable().optional(),
    windowsRemoteSessionLaunchMode: z.enum(['hidden', 'windows_terminal', 'console']).nullable().optional(),
  }).strict().refine(value => Object.keys(value).length > 0),
}).strict());
export const MachineStopDaemonInputSchema = lazyZodSchema(() => z.object(machineTarget).strict());
export const MachineRemoveInputSchema = lazyZodSchema(() => z.object(machineTarget).strict());
export const MachineCapabilityInstallInputSchema = lazyZodSchema(() => z.object({
  ...machineTarget,
  capabilityId: InstallableCapabilityIdSchema,
  method: z.enum(['install', 'upgrade']),
}).strict());
export const MachineCapabilityInstallOutputSchema = lazyZodSchema(() => z.discriminatedUnion('supported', [
  z.object({ supported: z.literal(true), response: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), result: StrictJsonValueSchema.optional() }).strict(),
    z.object({ ok: z.literal(false), error: z.object({ message: z.string(), code: z.string().optional() }).strict(), logPath: z.string().optional() }).strict(),
  ]) }).strict(),
  z.object({ supported: z.literal(false), reason: z.enum(['not-supported', 'error']),
    requestDisposition: z.enum(['notSent', 'outcomeUnknown']).optional() }).strict(),
]));
export const MachineReplacementSetInputSchema = lazyZodSchema(() => z.object({
  ...machineTarget, replacementMachineId: id, confirmActiveOldMachine: z.boolean().optional(),
}).strict());
export const MachineReplacementClearInputSchema = lazyZodSchema(() => z.object(machineTarget).strict());
export const MachineReplacementOutputSchema = lazyZodSchema(() => z.union([
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), status: z.number().int(), error: z.string() }).strict(),
]));
export const MACHINE_PAGE_ACTION_INPUT_SCHEMAS = {
  'machines.metadata.update': MachineMetadataUpdateInputSchema,
  'machines.daemon.stop': MachineStopDaemonInputSchema,
  'machines.remove': MachineRemoveInputSchema,
  'machines.capabilities.install': MachineCapabilityInstallInputSchema,
  'machines.replacement.set': MachineReplacementSetInputSchema,
  'machines.replacement.clear': MachineReplacementClearInputSchema,
} as const;
export const MACHINE_PAGE_ACTION_OUTPUT_SCHEMAS = {
  'machines.metadata.update': lazyZodSchema(() => z.object({ version: z.number().int().nonnegative() }).strict()),
  'machines.daemon.stop': lazyZodSchema(() => z.object({ message: z.string() }).strict()),
  'machines.remove': lazyZodSchema(() => z.union([
    z.object({ ok: z.literal(true), machineAlreadyRevoked: z.boolean(), providerCleanup: z.enum(['complete', 'not_needed']) }).strict(),
    z.object({ ok: z.literal(false), status: z.number().int(), error: z.string(), machineRevoked: z.literal(true), providerCleanup: z.literal('pending'), retryable: z.boolean() }).strict(),
    z.object({ ok: z.literal(false), status: z.number().int(), error: z.string() }).strict(),
  ])),
  'machines.capabilities.install': MachineCapabilityInstallOutputSchema,
  'machines.replacement.set': MachineReplacementOutputSchema,
  'machines.replacement.clear': MachineReplacementOutputSchema,
} as const;
export type MachinePageActionInput = z.infer<(typeof MACHINE_PAGE_ACTION_INPUT_SCHEMAS)[MachinePageActionId]>;
export const HomeConnectInputSchema = lazyZodSchema(() => z.object({
  address: id,
  displayName: id.optional(),
  acceptInsecureHttp: z.boolean().default(false),
  acceptCanonicalUrl: z.boolean().default(false),
}).strict());
export const HomeConnectOutputSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('connected'), serverId: id, serverUrl: id, name: z.string() }).strict(),
  z.object({ kind: z.literal('invalid_address') }).strict(),
  z.object({ kind: z.literal('declined') }).strict(),
  z.object({ kind: z.literal('mixed_content') }).strict(),
  z.object({ kind: z.literal('unreachable') }).strict(),
]));
export const MachineAddCommandInputSchema = lazyZodSchema(() => z.discriminatedUnion('method', [
  z.object({ method: z.literal('another_computer'), serverId: id, os: z.enum(['macos', 'linux', 'windows']) }).strict(),
  z.object({ method: z.literal('ssh'), serverId: id, os: z.enum(['macos', 'linux', 'windows']),
    host: id, username: z.string().optional(), port: z.number().int().min(1).max(65535).optional(),
    authMode: z.enum(['agent', 'keyfile', 'password']).default('agent'), identityFilePath: z.string().optional(),
  }).strict(),
]));
export const MachineAddCommandOutputSchema = lazyZodSchema(() => z.object({ command: id, descriptorFileRequired: z.boolean() }).strict());
export const MachinePairingCreateInputSchema = lazyZodSchema(() => z.object({ serverId: id }).strict());
export const MachinePairingCreateOutputSchema = lazyZodSchema(() => z.object({ pairId: id, link: id, expiresAtMs: z.number().int().nonnegative() }).strict());
export const MACHINE_ADD_SSH_ACTION_IDS = ['machines.add.ssh.start', 'machines.add.ssh.status', 'machines.add.ssh.respond', 'machines.add.ssh.cancel'] as const;
export type MachineAddSshActionId = typeof MACHINE_ADD_SSH_ACTION_IDS[number];
export const MachineAddSshStartInputSchema = lazyZodSchema(() => z.union([z.object({ serverId: id, host: id, username: z.string().default(''),
  port: z.number().int().min(1).max(65535).optional(), authMode: z.enum(['agent', 'keyfile', 'password']).default('agent'),
  identityFilePath: z.string().optional(),
}).strict(), z.object({ serverId: id, savedHostId: id,
  expectedHostRevision: z.union([z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), z.literal('absent')]),
}).strict()]));
export const MachineAddSshTaskInputSchema = lazyZodSchema(() => z.object({ taskId: id }).strict());
export const MachineAddSshCancelInputSchema = lazyZodSchema(() => z.object({ taskId: id.optional() }).strict());
export const MachineAddSshAnswerSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ssh.password') }).strict(),
  z.object({ kind: z.literal('ssh.trustHost'), trusted: z.boolean() }).strict(),
  z.object({ kind: z.literal('ssh.replaceHostKey'), trusted: z.boolean() }).strict(),
  z.object({ kind: z.literal('auth.approveRemoteProvisioning'), approved: z.boolean() }).strict(),
  z.object({ kind: z.literal('daemon.replaceRemoteBackgroundServices'), replaceExistingServices: z.boolean() }).strict(),
  z.object({ kind: z.literal('releaseChannel.switchDefaultForSetup'), switchDefaultReleaseChannel: z.boolean() }).strict(),
]));
export const MachineAddSshRespondInputSchema = lazyZodSchema(() => MachineAddSshTaskInputSchema.extend({ answer: MachineAddSshAnswerSchema }).strict());
export const MachineAddSshTaskOutputSchema = lazyZodSchema(() => z.object({ taskId: id }).strict());
export const MachineAddSshCancelOutputSchema = lazyZodSchema(() => z.union([
  MachineAddSshTaskOutputSchema, z.object({ pendingCanceled: z.literal(true) }).strict(),
]));
export const MachineAddSshStatusOutputSchema = lazyZodSchema(() => z.object({ taskId: id, status: z.enum(['running', 'canceling', 'succeeded', 'failed', 'canceled']),
  currentStepId: z.string().nullable(), awaitingInput: z.boolean(),
  prompt: z.object({ kind: id, message: z.string(), fingerprint: z.string().optional(), existingFingerprint: z.string().nullable().optional(),
    target: z.string().optional(), publicKey: z.string().nullable().optional(), requiresPresentUser: z.boolean() }).strict().nullable(),
  machineId: z.string().nullable(), errorCode: z.string().nullable(),
}).strict());
export const MACHINE_ADD_SSH_INPUT_SCHEMAS = {
  'machines.add.ssh.start': MachineAddSshStartInputSchema, 'machines.add.ssh.status': MachineAddSshTaskInputSchema,
  'machines.add.ssh.respond': MachineAddSshRespondInputSchema, 'machines.add.ssh.cancel': MachineAddSshCancelInputSchema,
} as const;

const clientSurfaces = { ui: true, voice: false, agent: true, mcp: true, cli: false, rpc: false } as const;
export const MACHINE_CONNECTION_ACTION_SPECS = [
  {
    id: 'machines.metadata.update', approval: {result: 'required'}, title: 'Update machine details',
    description: 'Change the machine name or Windows session launch mode through versioned Machine metadata.',
    safety: 'safe', sideEffectClass: 'write', executionPlacement: 'client', placements: [],
    surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: false, rpc: false },
    bindings: { mcpToolName: 'machines_metadata_update' },
    cli: { commands: [{ path: ['machines', 'metadata', 'update'], visibility: 'canonical' }] },
    toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
    inputSchema: MACHINE_PAGE_ACTION_INPUT_SCHEMAS['machines.metadata.update'], outputSchema: MACHINE_PAGE_ACTION_OUTPUT_SCHEMAS['machines.metadata.update'],
    inputHints: { fields: [
      { path: 'serverId', title: 'Home ID', widget: 'text' }, { path: 'machineId', title: 'Machine ID', widget: 'text', required: true },
      { path: 'expectedVersion', title: 'Metadata version', widget: 'text' }, { path: 'patch', title: 'Changes', widget: 'json', required: true },
    ] },
  },
  {
    id: 'machines.daemon.stop', approval: {result: 'required'}, title: 'Stop machine daemon',
    description: 'Stop the daemon on this machine through its existing stop RPC.',
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'machine', placements: [],
    surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: false, rpc: false },
    bindings: { mcpToolName: 'machines_daemon_stop' },
    cli: { commands: [{ path: ['machines', 'daemon', 'stop'], visibility: 'canonical' }] },
    toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
    inputSchema: MACHINE_PAGE_ACTION_INPUT_SCHEMAS['machines.daemon.stop'], outputSchema: MACHINE_PAGE_ACTION_OUTPUT_SCHEMAS['machines.daemon.stop'],
    inputHints: { fields: [{ path: 'serverId', title: 'Home ID', widget: 'text' }, { path: 'machineId', title: 'Machine ID', widget: 'text', required: true }] },
  },
  {
    id: 'machines.remove', approval: {result: 'required'}, title: 'Remove machine',
    description: 'Revoke the machine from its Home and clean up its Provider state.',
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'account', placements: [],
    surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: false, rpc: false },
    bindings: { mcpToolName: 'machines_remove' },
    cli: { commands: [{ path: ['machines', 'remove'], visibility: 'canonical' }] },
    toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
    inputSchema: MACHINE_PAGE_ACTION_INPUT_SCHEMAS['machines.remove'], outputSchema: MACHINE_PAGE_ACTION_OUTPUT_SCHEMAS['machines.remove'],
    inputHints: { fields: [{ path: 'serverId', title: 'Home ID', widget: 'text' }, { path: 'machineId', title: 'Machine ID', widget: 'text', required: true }] },
  },
  {
    id: 'machines.capabilities.install', approval: {result: 'required'}, title: 'Install machine capability',
    description: 'Install, update, or reinstall one installable dependency through the machine daemon capability owner.',
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'machine', placements: [],
    surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: false, rpc: false },
    bindings: { mcpToolName: 'machines_capabilities_install' },
    cli: { commands: [{ path: ['machines', 'capabilities', 'install'], visibility: 'canonical' }] },
    toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
    inputSchema: MachineCapabilityInstallInputSchema, outputSchema: MachineCapabilityInstallOutputSchema,
    inputHints: { fields: [
      { path: 'serverId', title: 'Home ID', widget: 'text' }, { path: 'machineId', title: 'Machine ID', widget: 'text', required: true },
      { path: 'capabilityId', title: 'Installable capability ID', widget: 'text', required: true },
      { path: 'method', title: 'Install or upgrade', widget: 'select', required: true,
        options: [{ value: 'install', label: 'Install or reinstall' }, { value: 'upgrade', label: 'Upgrade' }] },
    ] },
  },
  {
    id: 'machines.replacement.set', approval: {result: 'required'}, title: 'Replace a machine',
    description: 'Mark a machine as replaced by another machine through its existing Home enrollment owner.',
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'account', placements: [],
    surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: false, rpc: false },
    bindings: { mcpToolName: 'machines_replacement_set' },
    serverTransport: { method: 'POST', path: '/v1/machines/:machineId/replacement' },
    cli: { commands: [{ path: ['machines', 'replacement', 'set'], visibility: 'canonical' }] },
    toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
    inputSchema: MachineReplacementSetInputSchema, outputSchema: MachineReplacementOutputSchema,
    inputHints: { fields: [
      { path: 'serverId', title: 'Home ID', widget: 'text' }, { path: 'machineId', title: 'Machine ID', widget: 'text', required: true },
      { path: 'replacementMachineId', title: 'Replacement Machine ID', widget: 'text', required: true },
      { path: 'confirmActiveOldMachine', title: 'Confirm replacement of an active machine', widget: 'boolean' },
    ] },
  },
  {
    id: 'machines.replacement.clear', approval: {result: 'required'}, title: 'Undo machine replacement',
    description: 'Clear a machine replacement through the same Home enrollment owner.',
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'account', placements: [],
    surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: false, rpc: false },
    bindings: { mcpToolName: 'machines_replacement_clear' },
    serverTransport: { method: 'DELETE', path: '/v1/machines/:machineId/replacement' },
    cli: { commands: [{ path: ['machines', 'replacement', 'clear'], visibility: 'canonical' }] },
    toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
    inputSchema: MachineReplacementClearInputSchema, outputSchema: MachineReplacementOutputSchema,
    inputHints: { fields: [{ path: 'serverId', title: 'Home ID', widget: 'text' }, { path: 'machineId', title: 'Machine ID', widget: 'text', required: true }] },
  },
  {
    id: 'machines.add.ssh.start', approval: {result: 'required'}, title: 'Add machine over SSH',
    description: 'Start SSH setup on the focused signed-in Home using a target or saved host. Credentials stay in private task custody or are resolved from the captured saved host; they are never Action arguments.',
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'client', placements: [], surfaces: clientSurfaces,
    bindings: { mcpToolName: 'machines_add_ssh_start' }, inputSchema: MachineAddSshStartInputSchema, outputSchema: MachineAddSshTaskOutputSchema,
    inputHints: { fields: [{ path: 'serverId', title: 'Home ID', widget: 'text', required: true }, { path: 'host', title: 'SSH host', widget: 'text' },
      { path: 'savedHostId', title: 'Saved host ID', widget: 'text' }, { path: 'expectedHostRevision', title: 'Saved host catalog revision', widget: 'text' },
      { path: 'username', title: 'SSH user', widget: 'text' }, { path: 'port', title: 'SSH port', widget: 'text' }, { path: 'authMode', title: 'Authentication', widget: 'text' },
      { path: 'identityFilePath', title: 'Identity file', widget: 'text' }] },
  },
  {
    id: 'machines.add.ssh.status', approval: {result: 'required'}, title: 'Read SSH machine setup', description: 'Read the retained SSH setup task and its current prompt. Task success is not proof of Home feed arrival.',
    safety: 'safe', sideEffectClass: 'read', executionPlacement: 'client', placements: [], surfaces: clientSurfaces,
    bindings: { mcpToolName: 'machines_add_ssh_status' }, inputSchema: MachineAddSshTaskInputSchema, outputSchema: MachineAddSshStatusOutputSchema,
    inputHints: { fields: [{ path: 'taskId', title: 'Task ID', widget: 'text', required: true }] },
  },
  {
    id: 'machines.add.ssh.respond', approval: {result: 'required'}, title: 'Answer SSH setup prompt', description: 'Answer the exact current SSH setup prompt; trust and service changes are never accepted implicitly.',
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'client', placements: [], surfaces: clientSurfaces,
    bindings: { mcpToolName: 'machines_add_ssh_respond' }, inputSchema: MachineAddSshRespondInputSchema, outputSchema: MachineAddSshTaskOutputSchema,
    inputHints: { fields: [{ path: 'taskId', title: 'Task ID', widget: 'text', required: true }, { path: 'answer', title: 'Prompt answer', widget: 'json', required: true }] },
  },
  {
    id: 'machines.add.ssh.cancel', approval: {result: 'required'}, title: 'Cancel SSH machine setup', description: 'Cancel the retained SSH task through its existing system-task owner. Omit taskId to cancel its pending native start.',
    safety: 'safe', sideEffectClass: 'write', executionPlacement: 'client', placements: [], surfaces: clientSurfaces,
    bindings: { mcpToolName: 'machines_add_ssh_cancel' }, inputSchema: MachineAddSshCancelInputSchema, outputSchema: MachineAddSshCancelOutputSchema,
    inputHints: { fields: [{ path: 'taskId', title: 'Task ID', widget: 'text' }] },
  },
  {
    id: 'homes.connect', approval: {result: 'required'}, title: 'Connect a Home by address',
    description: 'Check and save a Home address, returning the canonical connection outcome. Device focus stays with the current Home.',
    safety: 'safe', sideEffectClass: 'write', executionPlacement: 'client', placements: [], surfaces: clientSurfaces,
    bindings: { mcpToolName: 'homes_connect' }, inputSchema: HomeConnectInputSchema, outputSchema: HomeConnectOutputSchema,
    inputHints: { fields: [{ path: 'address', title: 'Home address', widget: 'text', required: true },
      { path: 'displayName', title: 'Home name', widget: 'text' },
      { path: 'acceptInsecureHttp', title: 'Accept insecure HTTP', widget: 'boolean' },
      { path: 'acceptCanonicalUrl', title: 'Use the advertised canonical address', widget: 'boolean' }] },
  },
  {
    id: 'machines.add.command', approval: {result: 'required'}, title: 'Prepare machine setup command',
    description: 'Get the existing SSH or another-computer setup command for a saved Home. This does not install or connect the machine.',
    safety: 'safe', sideEffectClass: 'read', executionPlacement: 'client', placements: [], surfaces: clientSurfaces,
    bindings: { mcpToolName: 'machines_add_command' }, inputSchema: MachineAddCommandInputSchema, outputSchema: MachineAddCommandOutputSchema,
    inputHints: { fields: [{ path: 'serverId', title: 'Home ID', widget: 'text', required: true },
      { path: 'method', title: 'Setup method', widget: 'select', required: true, options: [{ value: 'another_computer', label: 'Another computer' }, { value: 'ssh', label: 'SSH' }] },
      { path: 'os', title: 'Operating system', widget: 'select', required: true, options: [{ value: 'macos', label: 'macOS' }, { value: 'linux', label: 'Linux' }, { value: 'windows', label: 'Windows' }] },
      { path: 'host', title: 'SSH host', widget: 'text' }, { path: 'username', title: 'SSH user', widget: 'text' },
      { path: 'port', title: 'SSH port', widget: 'text' }, { path: 'authMode', title: 'SSH authentication', widget: 'text' }, { path: 'identityFilePath', title: 'Identity file', widget: 'text' }] },
  },
  {
    id: 'machines.pairing.create', approval: {result: 'required'}, title: 'Create link to add another computer',
    description: 'Issue a short-lived Home pairing link through the trusted device enrollment lifecycle. Keep this client running until the computer joins.',
    safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'client', placements: [], surfaces: clientSurfaces,
    bindings: { mcpToolName: 'machines_pairing_create' }, inputSchema: MachinePairingCreateInputSchema, outputSchema: MachinePairingCreateOutputSchema,
    projectObservationOutput: () => ({ redacted: true }),
    approvalResultCustody: 'live_only',
    inputHints: { description: 'Make a link that adds another computer to a Home. It works for a short time; keep this device open until the computer has joined.',
      fields: [{ path: 'serverId', title: 'Home ID', widget: 'text', required: true }] },
  },
] as const satisfies readonly PreNormalizedActionSpec[];
