import { z } from 'zod/mini';

import { AcpConfigOptionOverridesV1Schema } from '@happier-dev/protocol/sessions/metadata/overrides';
import { BackendTargetKeySchema, BackendTargetRefSchema, buildBackendTargetKey } from '@happier-dev/protocol/backends/targets/backendTargetRef';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { ConnectedServiceBindingsV2IngressSchema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { SessionMcpSelectionV1Schema } from '@happier-dev/protocol/mcp/servers/sessionSelectionV1';
import { readCapabilitySelectionCarrierV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import { SessionPermissionModeSchema } from '@happier-dev/protocol/sessions/metadata/permission-modes';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { SpawnConfigOptionValueSchema, findSpawnConfigOptionAliasConflicts, mergeSpawnConfigOptionAliases } from '@happier-dev/protocol/actions/sessionSpawnConfigOptions';
import { resolveExplicitSessionSpawnMachineTarget } from '@happier-dev/protocol/actions/sessionSpawnMachineTarget';
import { readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { ApprovalRequestV1, BackendTargetRefV2, SessionSpawnNewInputV2, SpawnConfigOptionValue } from '@happier-dev/protocol';

type ReplayAgentDefinition = Readonly<{
  id: string;
  identity?: Readonly<{ pluginId: string; localId: string }>;
}>;

type LocalMachineIdentity = Readonly<{
  machineId: string | null;
  host: string | null;
}>;

const LegacySpawnTerminalSchema = z.strictObject({
  mode: z.optional(z.enum(['plain', 'tmux', 'windows_terminal', 'windows_console'])),
  tmux: z.optional(z.strictObject({
    sessionName: z.optional(z.string()),
    isolated: z.optional(z.boolean()),
    tmpDir: z.optional(z.nullable(z.string())),
  })),
});

/**
 * Exact Session-spawn Action artifact grammar written by remote-dev before
 * public V2 Session creation. It is deliberately private to approval replay:
 * live Action and RPC ingress stay strict V2/private-machine respectively.
 *
 * Provenance: remote-dev@fbb5cebec0e8f026af1b94bf3974105f98b26b0c,
 * packages/protocol/src/actions/actionSpecs.ts SessionSpawnNewInputSchema.
 * Remove when pre-V2 Session-spawn approval artifacts are no longer a
 * supported/reachable persistence input.
 */
const RemoteDevSessionSpawnApprovalArgsSchema = z.strictObject({
  tag: z.optional(z.string().check(z.minLength(1))),
  tags: z.optional(z.array(z.string().check(z.minLength(1)))),
  agentId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  backend: z.optional(z.string().check(z.trim(), z.minLength(1))),
  target: z.optional(z.string().check(z.trim(), z.minLength(1))),
  modelId: z.optional(z.string().check(z.minLength(1))),
  backendTargetKey: z.optional(BackendTargetKeySchema),
  backendTarget: z.optional(BackendTargetRefSchema),
  title: z.optional(z.string().check(z.minLength(1))),
  path: z.optional(z.string().check(z.minLength(1))),
  directory: z.optional(z.string().check(z.minLength(1))),
  host: z.optional(z.string().check(z.minLength(1))),
  machineId: z.optional(z.string().check(z.minLength(1))),
  prompt: z.optional(z.string().check(z.minLength(1))),
  initialPrompt: z.optional(z.string().check(z.minLength(1))),
  initialMessage: z.optional(z.string().check(z.minLength(1))),
  permissionMode: z.optional(SessionPermissionModeSchema),
  agentModeId: z.optional(z.string().check(z.minLength(1))),
  sessionConfigOptionOverrides: z.optional(AcpConfigOptionOverridesV1Schema),
  configOptions: z.optional(z.record(z.string().check(z.minLength(1)), SpawnConfigOptionValueSchema)),
  profileId: z.optional(z.string().check(z.minLength(1))),
  environmentVariables: z.optional(z.record(z.string().check(z.minLength(1)), z.string())),
  connectedServices: z.optional(ConnectedServiceBindingsV2IngressSchema),
  connectedServicesUpdatedAt: z.optional(z.number().check(z.int())),
  mcpSelection: z.optional(SessionMcpSelectionV1Schema),
  transcriptStorage: z.optional(z.enum(['persisted', 'direct'])),
  terminal: z.optional(LegacySpawnTerminalSchema),
  windowsRemoteSessionLaunchMode: z.optional(z.enum(['hidden', 'windows_terminal', 'console'])),
  windowsRemoteSessionConsole: z.optional(z.enum(['hidden', 'visible'])),
  windowsTerminalWindowName: z.optional(z.string().check(z.minLength(1))),
  codexBackendMode: z.optional(z.enum(['mcp', 'acp', 'appServer'])),
  agentRuntimeDescriptorV1: z.optional(z.unknown()),
});

type RemoteDevSessionSpawnApprovalArgs = z.infer<
  typeof RemoteDevSessionSpawnApprovalArgsSchema
>;

const UNSUPPORTED_LEGACY_FIELDS = [
  'tags',
  'environmentVariables',
  'connectedServicesUpdatedAt',
  'codexBackendMode',
  'agentRuntimeDescriptorV1',
] as const;

function hasOwn(record: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function aliasesConflict(values: readonly (string | undefined)[]): boolean {
  const present = values.filter((value): value is string => value !== undefined);
  return present.length > 1 && !present.every((value) => value === present[0]);
}

function normalizeLegacyTargetString(value: string): string {
  const trimmed = value.trim();
  if (BackendTargetKeySchema.safeParse(trimmed).success) return trimmed;
  return trimmed === 'customAcp' ? trimmed : `agent:${trimmed}`;
}

function readTargetCandidate(value: unknown): BackendTargetRefV2 | null {
  try {
    return readBackendTargetRefV2(value as Parameters<typeof readBackendTargetRefV2>[0]);
  } catch {
    return null;
  }
}

function resolveLegacyTarget(input: RemoteDevSessionSpawnApprovalArgs): BackendTargetRefV2 | null {
  const aliases = [
    ...(input.agentId ? [normalizeLegacyTargetString(input.agentId)] : []),
    ...(input.backend ? [normalizeLegacyTargetString(input.backend)] : []),
    ...(input.target ? [normalizeLegacyTargetString(input.target)] : []),
    ...(input.backendTargetKey ? [input.backendTargetKey] : []),
    ...(input.backendTarget ? [buildBackendTargetKey(input.backendTarget)] : []),
  ];
  if (aliases.length === 0) return null;

  // Preserve the predecessor's one exceptional alias precisely: `customAcp`
  // was valid only alongside one concrete ACP target. It never identifies an
  // executable target by itself and must not become a V2 carrier.
  const concreteAliases = aliases.filter((alias) => alias !== 'customAcp');
  const hasCustomAcpAlias = aliases.some((alias) => alias === 'customAcp');
  if (concreteAliases.length === 0) return null;
  const hasConflictingConcreteTargets = new Set(concreteAliases).size > 1;
  const hasBuiltInTarget = concreteAliases.some((alias) => alias.startsWith('agent:'));
  const hasConcreteAcpTarget = concreteAliases.some((alias) => alias.startsWith('acpBackend:'));
  if (
    hasConflictingConcreteTargets
    || (hasCustomAcpAlias && (hasBuiltInTarget || !hasConcreteAcpTarget))
  ) {
    return null;
  }

  return readTargetCandidate(concreteAliases[0]!);
}

function resolveConfiguration(params: Readonly<{
  input: RemoteDevSessionSpawnApprovalArgs;
  createdAtMs: number;
}>): SessionSpawnNewInputV2['configuration'] | null | undefined {
  const configOptions = params.input.configOptions as Readonly<Record<string, SpawnConfigOptionValue>> | undefined;
  if (findSpawnConfigOptionAliasConflicts({
    sessionConfigOptionOverrides: params.input.sessionConfigOptionOverrides,
    configOptions,
  }).length > 0) {
    return null;
  }
  const merged = mergeSpawnConfigOptionAliases({
    sessionConfigOptionOverrides: params.input.sessionConfigOptionOverrides,
    configOptions,
    updatedAt: params.createdAtMs,
  });
  if (!merged) return undefined;
  if (
    !Number.isSafeInteger(merged.updatedAt)
    || merged.updatedAt < 0
    || !Object.entries(merged.overrides).every(([, override]) => (
      Number.isSafeInteger(override.updatedAt)
      && override.updatedAt >= 0
    ))
  ) {
    return null;
  }
  return {
    mode: { value: null, updatedAtMs: params.createdAtMs },
    model: { value: null, updatedAtMs: params.createdAtMs },
    permissionIntent: { value: null, updatedAtMs: params.createdAtMs },
    options: Object.fromEntries(Object.entries(merged.overrides).map(([id, override]) => [
      id,
      { value: override.value, updatedAtMs: override.updatedAt },
    ])),
  };
}

export function createRemoteDevSessionSpawnApprovalReplayNormalizer(params: Readonly<{
  readAgentDefinitions: () => Iterable<ReplayAgentDefinition>;
  readLocalMachineIdentity: () => Promise<LocalMachineIdentity>;
}>): (args: Readonly<{
  artifactId: string;
  request: ApprovalRequestV1;
  serverId: string | null;
  signal?: AbortSignal;
}>) => Promise<Readonly<{
  input: SessionSpawnNewInputV2;
  legacyMetadataLabel?: string;
}> | null> {
  return async (args) => {
    const artifactId = nonEmptyString(args.artifactId);
    const serverId = nonEmptyString(args.serverId);
    if (!artifactId || !serverId) return null;

    const rawInput = args.request.actionArgs;
    if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) return null;
    const rawRecord = rawInput as Readonly<Record<string, unknown>>;
    if (UNSUPPORTED_LEGACY_FIELDS.some((field) => hasOwn(rawRecord, field))) return null;

    const parsed = RemoteDevSessionSpawnApprovalArgsSchema.safeParse(rawInput);
    if (!parsed.success) return null;
    const input = parsed.data;
    if (
      aliasesConflict([input.path, input.directory])
      || aliasesConflict([input.prompt, input.initialPrompt, input.initialMessage])
    ) {
      return null;
    }
    const directory = input.directory ?? input.path ?? null;
    const initialMessage = input.initialMessage ?? input.initialPrompt ?? input.prompt;
    const machineId = nonEmptyString(input.machineId);
    if (!directory || !machineId) return null;

    const backendTarget = resolveLegacyTarget(input);
    if (!backendTarget) return null;
    const agent = [...params.readAgentDefinitions()].find((candidate) => (
      candidate.id === backendTarget.backendId
      && candidate.identity?.pluginId
      && candidate.identity.localId
    ));
    if (!agent?.identity) return null;

    if (input.host !== undefined) {
      const local = await params.readLocalMachineIdentity();
      const hostResolution = resolveExplicitSessionSpawnMachineTarget({
        machineId,
        host: input.host,
        machines: local.machineId
          ? [{ machineId: local.machineId, host: local.host }]
          : [],
      });
      if (hostResolution.kind !== 'resolved') return null;
    }

    const configuration = resolveConfiguration({
      input,
      createdAtMs: args.request.createdAtMs,
    });
    if (configuration === null) return null;
    const hasLegacyWindowsTerminal = input.windowsRemoteSessionLaunchMode !== undefined
      || input.windowsRemoteSessionConsole !== undefined
      || input.windowsTerminalWindowName !== undefined;
    // This private replay adapter is the only pre-V2 carrier accepted for the
    // predecessor's flat Windows facts. Its output is the single V2 terminal
    // shape; public Action and RPC ingress remain strict V2.
    const terminal = hasLegacyWindowsTerminal
      ? {
          ...(input.terminal ?? {}),
          windows: {
            ...(input.windowsRemoteSessionLaunchMode !== undefined
              ? { launchMode: input.windowsRemoteSessionLaunchMode }
              : {}),
            ...(input.windowsRemoteSessionConsole !== undefined
              ? { console: input.windowsRemoteSessionConsole }
              : {}),
            ...(input.windowsTerminalWindowName !== undefined
              ? { windowName: input.windowsTerminalWindowName }
              : {}),
          },
        }
      : input.terminal;

    const capabilitySelection = readCapabilitySelectionCarrierV1(input);
    const candidate = {
      creationKey: `approval-artifact:${artifactId}`,
      executionTarget: { serverId, machineId },
      directory: { kind: 'path', path: directory },
      agentTarget: { kind: 'agent' as const, identity: agent.identity },
      ...(input.modelId && input.modelId !== 'default'
        ? {
            modelSelection: {
              v: 1 as const,
              updatedAt: args.request.createdAtMs,
              ref: {
                agentTargetKey: buildBackendTargetKeyV2(backendTarget),
                providerConnectionId: null,
                modelId: input.modelId,
              },
            },
          }
        : {}),
      ...(input.title ? { title: input.title } : {}),
      ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
      ...(input.agentModeId ? { agentModeId: input.agentModeId } : {}),
      ...(configuration ? { configuration } : {}),
      ...(input.connectedServices ? { connectedServices: input.connectedServices } : {}),
      ...(capabilitySelection ? { capabilitySelection } : {}),
      ...(input.transcriptStorage ? { transcriptStorage: input.transcriptStorage } : {}),
      ...(terminal ? { terminal } : {}),
      ...(input.profileId ? { profileId: input.profileId } : {}),
      ...(initialMessage ? { initialInput: { text: initialMessage } } : {}),
    };
    const canonical = SessionSpawnNewInputV2Schema.safeParse(candidate);
    if (!canonical.success) return null;
    const legacyMetadataLabel = nonEmptyString(input.tag);
    if (input.tag !== undefined && !legacyMetadataLabel) return null;
    return {
      input: canonical.data,
      ...(legacyMetadataLabel ? { legacyMetadataLabel } : {}),
    };
  };
}
