import {
  type ActionId,
  type ActionsSettingsV1,
  type ApprovalRequestOriginV1,
  type ResolvedActionOption,
  type ReviewCommentPrincipalHeaderV1,
} from '@happier-dev/protocol';
import { createActionToolNameToIdMap, listPluginActionBackedTools, resolveActionToolCatalogAvailability, resolveDiscoveredPluginActionAvailability } from './actionToolCatalog';
import { ActionDefinitionV1Schema } from '@happier-dev/protocol/actions/actionDefinitionV1';
import { isAgentStartActionInvocationV1, requiresActionAgentStartDepthV1 } from '@happier-dev/protocol/actions/executor/agentStartAdmission';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { normalizeExecutionRunToolResult } from './executionRunToolResult';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { ProjectedPluginToolCatalogEntry } from '@/plugins/runtime/toolCatalog';
import { bindContextualActionToolInput, projectSessionBoundActionToolInputSchema } from './actionToolContext';
import { preparePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { actionInputIssueFailure, projectActionInputJsonSchemaIssues } from '@happier-dev/protocol/actions/executor/actionInputValidation';
import { AgentRuntimeJsonValueV1Schema } from '@happier-dev/protocol/runtime/agentSessionV1';
import { createSensitiveDiagnosticTextRedactor } from '@happier-dev/protocol/bugs/reports/redaction';
import type { SensitiveDiagnosticValuesLease } from '@happier-dev/protocol/bugs/reports';
import { projectTargetActionFailure } from '@/plugins/runtime/invocation/actionExecutor';
import { registerTargetActionDiagnosticInput } from '@/plugins/runtime/invocation/diagnostics';
import { materializeActionRequestAttributionV1, type ActionRequestAttributionV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';

type ActionExecutorResult = Readonly<
  | { ok: true; result: unknown }
  | { ok: false; errorCode: string; error: string; details?: unknown }
>;

type ActionExecutorLike = Readonly<{
  execute: (
    actionId: ActionId,
    input: unknown,
    ctx: Readonly<{
      defaultSessionId: string;
      defaultSessionMachineId?: string | null;
      surface: 'mcp' | 'cli' | 'agent';
      authority?: 'account_automation';
      approvalOrigin?: ApprovalRequestOriginV1 | null;
      callerPermissionMode?: string | null;
      causalPermissionAuthority?: unknown;
      actionRequestAttributionV1?: ActionRequestAttributionV1;
      sessionInputSource?: unknown;
      sessionAgentSpawnPolicyV1?: unknown;
      runtimeRunId?: string;
      actionsSettings?: ActionsSettingsV1 | null;
      actionRequestId?: string | null;
      signal?: AbortSignal;
      onWaitSnapshot?: (snapshot: unknown) => void | Promise<void>;
      expectedContributorOccurrenceId?: string;
      sessionListAccess?: 'current_session' | 'led_subtree';
      reviewCommentPrincipal?: ReviewCommentPrincipalHeaderV1;
    }>,
  ) => Promise<ActionExecutorResult>;
}>;

type ActionToolBridgeResult =
  | Readonly<{ ok: true; result: unknown }>
  | Readonly<{ ok: false; errorCode: string; error: string; details?: unknown }>;

type DynamicActionOptionsResult = Readonly<{
  actionId: ActionId | null;
  fieldPath: string | null;
  optionsSourceId: string | null;
  options: readonly ResolvedActionOption[];
}>;

type DynamicActionOptionsBridgeResult =
  | Readonly<{ ok: true; result: DynamicActionOptionsResult }>
  | Readonly<{ ok: false; errorCode: string; error: string; details?: unknown }>;

export type ResolveActionOptionsInput = Readonly<{
  actionId: ActionId | null;
  fieldPath: string | null;
  optionsSourceId: string | null;
  sessionId: string | null;
  limit: number | null;
  query: string | null;
}> & Readonly<Record<string, unknown>>;

export type ActionToolExecutionOptions = Readonly<{
  signal?: AbortSignal;
  onWaitSnapshot?: (snapshot: unknown) => void | Promise<void>;
  approvalOrigin?: ApprovalRequestOriginV1 | null;
  /** Host-stamped invocation identity; independent from descriptive transcript provenance. */
  actionRequestId?: string | null;
}>;

function normalizeActionExecutorResult(result: ActionExecutorResult): ActionToolBridgeResult {
  return result.ok
    ? { ok: true, result: result.result }
    : {
        ok: false,
        errorCode: result.errorCode,
        error: result.error,
        ...(result.details !== undefined ? { details: result.details } : {}),
      };
}

function normalizeActionToolResult(
  actionId: string,
  result: ActionExecutorResult,
  input: unknown,
): ActionToolBridgeResult {
  if (result.ok && isInputRecord(result.result) && result.result.kind === 'approval_request_created') {
    return { ok: true, result: result.result };
  }
  if (!actionId.startsWith('execution.run.')) {
    return normalizeActionExecutorResult(result);
  }

  if (!result.ok) {
    return {
      ok: false,
      errorCode: result.errorCode,
      error: result.error,
      ...(result.details !== undefined ? { details: result.details } : {}),
    };
  }

  return normalizeExecutionRunToolResult(
    result.result,
    actionId === 'execution.run.wait'
      ? { runId: readTrimmedStringField(isInputRecord(input) ? input : {}, 'runId') }
      : undefined,
  );
}

async function buildActionExecutorContext(params: Readonly<{
  actionId: string;
  input: unknown;
  defaultSessionId: string;
  defaultSessionMachineId?: string | null;
  surface: 'mcp' | 'cli' | 'agent';
  options?: ActionToolExecutionOptions;
  resolveCallerPermissionMode?: (() => Promise<string | null> | string | null) | null;
  resolveActiveTurnPermissionWitness?: (() => Promise<unknown> | unknown) | null;
  sessionInputVia?: 'action' | 'mcp';
  sessionAgentSpawnPolicyV1?: unknown;
  getSessionAgentSpawnPolicyV1?: ((signal?: AbortSignal) => unknown) | null;
  resolveRuntimeRunId?: () => string | undefined;
  actionsSettings?: ActionsSettingsV1 | null;
  expectedContributorOccurrenceId?: string;
  sessionListAccess?: 'current_session' | 'led_subtree';
  resolveReviewCommentActor?: (() => Extract<ReviewCommentPrincipalHeaderV1['actor'], { kind: 'agent' }> | null) | null;
}>): Promise<Readonly<{
  defaultSessionId: string;
  defaultSessionMachineId?: string | null;
  surface: 'mcp' | 'cli' | 'agent';
  approvalOrigin?: ApprovalRequestOriginV1 | null;
  authority?: 'account_automation';
  callerPermissionMode?: string | null;
  causalPermissionAuthority?: unknown;
  actionRequestAttributionV1?: ActionRequestAttributionV1;
  sessionInputSource?: unknown;
  sessionAgentSpawnPolicyV1?: unknown;
  actionsSettings?: ActionsSettingsV1 | null;
  runtimeRunId?: string;
  actionRequestId?: string | null;
  expectedContributorOccurrenceId?: string;
  sessionListAccess?: 'current_session' | 'led_subtree';
  reviewCommentPrincipal?: ReviewCommentPrincipalHeaderV1;
  onWaitSnapshot?: (snapshot: unknown) => void | Promise<void>;
}>> {
  const callerPermissionMode = params.surface === 'agent' && params.resolveCallerPermissionMode
    ? await params.resolveCallerPermissionMode()
    : null;
  const reviewActor = params.surface !== 'cli' ? params.resolveReviewCommentActor?.() : null;
  const hasActiveTurnPermissionWitnessResolver =
    params.surface !== 'cli'
    && typeof params.resolveActiveTurnPermissionWitness === 'function';
  let causalPermissionAuthority: unknown = null;
  let activeTurnAttribution: unknown;
  let activeTurnId: string | null = null;
  let activeInputId: string | null = null;
  if (hasActiveTurnPermissionWitnessResolver) {
    try {
      const rawWitness = await params.resolveActiveTurnPermissionWitness!();
      const witness = isInputRecord(rawWitness) ? rawWitness : null;
      causalPermissionAuthority = witness?.causalPermissionAuthority ?? null;
      activeTurnAttribution = witness?.actionRequestAttributionV1;
      activeTurnId = typeof witness?.turnId === 'string' && witness.turnId.trim().length > 0
        ? witness.turnId.trim()
        : null;
      activeInputId = typeof witness?.inputId === 'string' && witness.inputId.trim().length > 0
        ? witness.inputId.trim()
        : null;
    } catch {
      // An active-turn reader failure is non-authorizing; do not fall back to
      // the mutable Session permission mode for an agent-originated call.
      causalPermissionAuthority = null;
    }
  }
  const sessionAgentSpawnPolicyV1 =
    params.getSessionAgentSpawnPolicyV1 && (requiresActionAgentStartDepthV1(params.actionId)
      || isAgentStartActionInvocationV1(params.actionId, isInputRecord(params.input) ? params.input : {}))
      ? await params.getSessionAgentSpawnPolicyV1(params.options?.signal)
      : params.sessionAgentSpawnPolicyV1;
  const origin = params.options?.approvalOrigin;
  const runtimeRunId = params.surface === 'agent' ? params.resolveRuntimeRunId?.() : undefined;
  const explicitActionRequestId = params.options?.actionRequestId;
  const actionRequestId = typeof explicitActionRequestId === 'string'
    && explicitActionRequestId.trim().length > 0
    ? explicitActionRequestId.trim()
    : origin
      ? [origin.toolCallId, origin.mcpRequestId, origin.messageId, origin.parentMessageId]
          .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
          ?.trim() ?? null
      : null;
  return {
    defaultSessionId: params.defaultSessionId,
    ...(runtimeRunId ? { runtimeRunId } : {}),
    ...(params.defaultSessionMachineId ? { defaultSessionMachineId: params.defaultSessionMachineId } : {}),
    surface: params.surface,
    ...(reviewActor && reviewActor.sessionId === params.defaultSessionId ? { reviewCommentPrincipal: { actor: reviewActor } } : {}),
    ...(params.surface === 'agent' ? { authority: 'account_automation' as const } : {}),
    ...(params.sessionListAccess
      ? { sessionListAccess: params.sessionListAccess }
      : params.surface === 'agent'
        ? { sessionListAccess: 'led_subtree' as const }
        : {}),
    ...(params.options?.approvalOrigin ? { approvalOrigin: params.options.approvalOrigin } : {}),
    ...(params.options?.signal ? { signal: params.options.signal } : {}),
    ...(params.options?.onWaitSnapshot ? { onWaitSnapshot: params.options.onWaitSnapshot } : {}),
    ...(actionRequestId ? { actionRequestId } : {}),
    ...(callerPermissionMode ? { callerPermissionMode } : {}),
    ...(hasActiveTurnPermissionWitnessResolver
      ? { causalPermissionAuthority: causalPermissionAuthority ?? null }
      : {}),
    ...(activeTurnAttribution !== undefined
      ? { actionRequestAttributionV1: materializeActionRequestAttributionV1(activeTurnAttribution) }
      : {}),
    ...(hasActiveTurnPermissionWitnessResolver && activeTurnId
      ? {
          sessionInputSource: {
            sourceSessionId: params.defaultSessionId,
            sourceTurnId: activeTurnId,
            ...(activeInputId ? { sourceInputId: activeInputId } : {}),
            via: params.sessionInputVia ?? 'action',
          },
        }
      : {}),
    ...(sessionAgentSpawnPolicyV1 !== undefined
      ? { sessionAgentSpawnPolicyV1 }
      : {}),
    ...(params.expectedContributorOccurrenceId
      ? { expectedContributorOccurrenceId: params.expectedContributorOccurrenceId }
      : {}),
    actionsSettings: params.actionsSettings ?? null,
  };
}

function resolveExpectedContributorOccurrenceId(params: Readonly<{
  actionId: string;
  toolName?: string;
  pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
}>): string | undefined {
  const occurrences = new Set(
    (params.pluginToolCatalog ?? [])
      .filter((tool) => (
        tool.actionId === params.actionId
        && (params.toolName === undefined || tool.name === params.toolName)
      ))
      .map((tool) => tool.expectedContributorOccurrenceId?.trim())
      .filter((value): value is string => Boolean(value)),
  );
  return occurrences.size === 1 ? [...occurrences][0] : undefined;
}

function normalizeActionExecuteInput(input: unknown): unknown {
  if (typeof input !== 'string') return input;

  const trimmed = input.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return input;

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return input;
  }
}

function isInputRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringField(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === 'string' ? value : null;
}

function readTrimmedStringField(record: Record<string, unknown>, field: string): string {
  return readStringField(record, field)?.trim() ?? '';
}

function readActionOptionsPayload(payload: unknown): DynamicActionOptionsResult | null {
  if (!isInputRecord(payload)) return null;
  const actionId = readStringField(payload, 'actionId');
  const fieldPath = readStringField(payload, 'fieldPath');
  const optionsSourceId = readStringField(payload, 'optionsSourceId');
  const optionsCandidate = payload.options;

  return {
    actionId: actionId as ActionId | null,
    fieldPath,
    optionsSourceId,
    options: Array.isArray(optionsCandidate) ? optionsCandidate as readonly ResolvedActionOption[] : [],
  };
}

export function createActionToolExecutorBridge(params: Readonly<{
  executor: ActionExecutorLike;
  isActionEnabled?: (id: ActionId) => boolean;
  surface?: 'mcp' | 'cli' | 'agent';
  actionsSettings?: ActionsSettingsV1 | null;
  getActionsSettings?: (() => ActionsSettingsV1 | null) | null;
  resolveCallerPermissionMode?: (() => Promise<string | null> | string | null) | null;
  resolveActiveTurnPermissionWitness?: (() => Promise<unknown> | unknown) | null;
  /** Reads identity from the live host Session client, never tool arguments. */
  resolveReviewCommentActor?: (() => Extract<ReviewCommentPrincipalHeaderV1['actor'], { kind: 'agent' }> | null) | null;
  sessionInputVia?: 'action' | 'mcp';
  sessionAgentSpawnPolicyV1?: unknown;
  getSessionAgentSpawnPolicyV1?: ((signal?: AbortSignal) => unknown) | null;
  resolveRuntimeRunId?: () => string | undefined;
  registry?: ResolvedContributionRegistry;
  pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
  requiredDirectActionIds?: readonly ActionId[];
  /** Map from the same admitted inventory used by tool registration. */
  actionToolNameToId?: ReadonlyMap<string, string>;
  defaultSessionMachineId?: string | null;
  defaultSessionRootPath?: string | null;
  /** Exact host-owned Session corpus available to non-Agent tool surfaces. */
  resolveSessionListAccess?: (defaultSessionId: string) => 'current_session' | 'led_subtree' | undefined;
}>): Readonly<{
  executeActionByToolName: (
    toolName: string,
    toolArgs: unknown,
    defaultSessionId: string,
    options?: ActionToolExecutionOptions,
  ) => Promise<ActionToolBridgeResult>;
  resolveActionOptions: (args: ResolveActionOptionsInput, defaultSessionId: string) => Promise<DynamicActionOptionsBridgeResult | null>;
  isActionEnabled: (id: ActionId) => boolean;
}> {
  const isActionEnabled = params.isActionEnabled ?? (() => true);
  const surface = params.surface ?? 'agent';
  const readActionsSettings = () => params.getActionsSettings?.() ?? params.actionsSettings ?? null;
  const actionToolNameToId = params.actionToolNameToId ?? createActionToolNameToIdMap({
    surface,
    isActionEnabled,
    actionsSettings: readActionsSettings(),
    registry: params.registry,
    pluginToolCatalog: params.pluginToolCatalog,
    requiredDirectActionIds: params.requiredDirectActionIds,
  });
  const resolveAvailability = (actionId: string, toolName?: string) => resolveActionToolCatalogAvailability({
    actionId,
    toolName,
    surface,
    isActionEnabled,
    actionsSettings: readActionsSettings(),
    registry: params.registry,
    pluginToolCatalog: params.pluginToolCatalog,
  });

  return {
    executeActionByToolName: async (toolName, toolArgs, defaultSessionId, options) => {
      if (toolName === 'action_execute') {
        const argsRecord = isInputRecord(toolArgs) ? toolArgs : null;
        const actionId = argsRecord ? readTrimmedStringField(argsRecord, 'actionId') : '';
        if (!actionId) {
          return { ok: false, errorCode: 'invalid_action_input', error: 'Missing actionId' };
        }
        const executorContext = await buildActionExecutorContext({
          actionId,
          input: argsRecord?.input,
          defaultSessionId,
          defaultSessionMachineId: params.defaultSessionMachineId,
          surface,
          options,
          resolveCallerPermissionMode: params.resolveCallerPermissionMode,
          resolveActiveTurnPermissionWitness: params.resolveActiveTurnPermissionWitness,
          resolveReviewCommentActor: params.resolveReviewCommentActor,
          sessionInputVia: params.sessionInputVia,
          sessionAgentSpawnPolicyV1: params.sessionAgentSpawnPolicyV1,
          getSessionAgentSpawnPolicyV1: params.getSessionAgentSpawnPolicyV1 ?? null,
          resolveRuntimeRunId: params.resolveRuntimeRunId,
          actionsSettings: readActionsSettings(),
          sessionListAccess: params.resolveSessionListAccess?.(defaultSessionId),
          expectedContributorOccurrenceId: resolveExpectedContributorOccurrenceId({ actionId, pluginToolCatalog: params.pluginToolCatalog }),
        });
        let definition: import('@happier-dev/protocol').ActionDefinitionV1 | null = null;
        if (parseQualifiedPluginActionId(actionId)) {
          const discovery = await params.executor.execute('action.spec.get', { id: actionId }, executorContext);
          if (!discovery.ok) return normalizeActionExecutorResult(discovery);
          const parsed = ActionDefinitionV1Schema.safeParse(isInputRecord(discovery.result) ? discovery.result.actionSpec : null);
          if (!parsed.success || parsed.data.id !== actionId) {
            return { ok: false, errorCode: 'action_disabled', error: 'Action is unavailable' };
          }
          definition = parsed.data;
        }
        const availability = definition
          ? resolveDiscoveredPluginActionAvailability({ actionId, surfaces: definition.surfaces, surface, actionsSettings: executorContext.actionsSettings })
          : resolveAvailability(actionId);
        if (!availability.available) {
          return { ok: false, errorCode: 'action_disabled', error: 'Action is disabled', details: availability };
        }
        const actionInput = bindContextualActionToolInput({
          actionId,
          contextualDefaults: definition?.contextualDefaults,
          input: argsRecord && Object.prototype.hasOwnProperty.call(argsRecord, 'input')
            ? normalizeActionExecuteInput(argsRecord.input)
            : {},
          context: { defaultSessionId, defaultSessionMachineId: params.defaultSessionMachineId, defaultSessionRootPath: params.defaultSessionRootPath },
          registry: params.registry,
          pluginToolCatalog: params.pluginToolCatalog,
        });
        return normalizeActionToolResult(actionId, await params.executor.execute(
          actionId as ActionId,
          actionInput,
          executorContext,
        ), actionInput);
      }

      const actionId = actionToolNameToId.get(toolName);
      if (!actionId) {
        return { ok: false, errorCode: 'unknown_tool', error: `Unknown action-backed tool: ${toolName}` };
      }
      const availability = resolveAvailability(actionId, toolName);
      if (!availability.available) {
        return { ok: false, errorCode: 'action_disabled', error: 'Action is disabled', details: availability };
      }

      // Host-generated Tools share their Action's schema and parser. Declared
      // plugin Tools (bundled or installed) own an independent, possibly narrower
      // JSON Schema contract. Admit that contract without running Action parsing,
      // defaults or transforms in the Tool/presentation layer.
      const tool = listPluginActionBackedTools({ registry: params.registry, pluginToolCatalog: params.pluginToolCatalog })
        .find(candidate => candidate.name === toolName && candidate.actionId === actionId);
      if (tool) {
        const schema = projectSessionBoundActionToolInputSchema({ actionId, inputSchema: tool.inputSchema,
          contextualDefaults: tool.contextualDefaults, registry: params.registry, pluginToolCatalog: params.pluginToolCatalog,
          context: { defaultSessionId, defaultSessionMachineId: params.defaultSessionMachineId, defaultSessionRootPath: params.defaultSessionRootPath } });
        if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
          return { ok: false, errorCode: 'action_schema_invalid', error: 'action_schema_invalid' };
        }
        const prepared = preparePluginJsonSchema(schema);
        if (!prepared.validate(toolArgs)) {
          // Capture the compiler's error bag before awaiting discovery, which
          // can itself compile/validate another schema in the same realm.
          const issues = projectActionInputJsonSchemaIssues(prepared.validate, prepared.jsonSchema, toolArgs);
          const discoveryInput = { id: actionId };
          const context = await buildActionExecutorContext({ actionId: 'action.spec.get', input: discoveryInput,
            defaultSessionId, surface, options, actionsSettings: readActionsSettings() });
          const discovery = await params.executor.execute('action.spec.get', discoveryInput, context);
          if (!discovery.ok) return normalizeActionExecutorResult(discovery);
          const definition = ActionDefinitionV1Schema.safeParse(isInputRecord(discovery.result) ? discovery.result.actionSpec : null);
          if (!definition.success || definition.data.id !== actionId) {
            return { ok: false, errorCode: 'action_disabled', error: 'Action is unavailable' };
          }
          const secretInputPaths = (definition.data.inputHints?.fields ?? [])
            .filter(field => field.widget === 'secret').map(field => field.path);
          const input = AgentRuntimeJsonValueV1Schema.safeParse(toolArgs);
          if (!input.success) return actionInputIssueFailure({ code: 'invalid_json_value', path: [] });
          const redactor = createSensitiveDiagnosticTextRedactor();
          const leases: SensitiveDiagnosticValuesLease[] = [];
          try {
            registerTargetActionDiagnosticInput(input.data, secretInputPaths, value => {
              if (value.length > 0) leases.push(redactor.register([value]));
            });
            const failure = projectTargetActionFailure({ status: 'invalid', code: 'plugin_action_input_schema_invalid',
              message: 'plugin_action_input_schema_invalid', issues: issues.map(issue => ({ ...issue, message: 'invalid_parameters' })) },
            value => redactor.redact(value), { input: input.data, secretInputPaths });
            return { ...actionInputIssueFailure(...('issues' in failure ? failure.issues ?? [] : [])),
              errorCode: 'plugin_action_input_schema_invalid', error: 'plugin_action_input_schema_invalid' };
          } finally { for (const lease of leases.reverse()) lease.close(); }
        }
      }

      const actionInput = bindContextualActionToolInput({
        actionId,
        input: toolArgs,
        context: { defaultSessionId, defaultSessionMachineId: params.defaultSessionMachineId, defaultSessionRootPath: params.defaultSessionRootPath },
        registry: params.registry,
        pluginToolCatalog: params.pluginToolCatalog,
      });
      return normalizeActionToolResult(actionId, await params.executor.execute(
        actionId as ActionId,
        actionInput,
        await buildActionExecutorContext({
          actionId,
          input: actionInput,
          defaultSessionId,
          defaultSessionMachineId: params.defaultSessionMachineId,
          surface,
          options,
          resolveCallerPermissionMode: params.resolveCallerPermissionMode,
          resolveActiveTurnPermissionWitness: params.resolveActiveTurnPermissionWitness,
          resolveReviewCommentActor: params.resolveReviewCommentActor,
          sessionInputVia: params.sessionInputVia,
          sessionAgentSpawnPolicyV1: params.sessionAgentSpawnPolicyV1,
          getSessionAgentSpawnPolicyV1: params.getSessionAgentSpawnPolicyV1 ?? null,
          resolveRuntimeRunId: params.resolveRuntimeRunId,
          actionsSettings: readActionsSettings(),
          sessionListAccess: params.resolveSessionListAccess?.(defaultSessionId),
          expectedContributorOccurrenceId:
            resolveExpectedContributorOccurrenceId({
              actionId,
              toolName,
              pluginToolCatalog: params.pluginToolCatalog,
            }),
        }),
      ), actionInput);
    },
    resolveActionOptions: async (args, defaultSessionId) => {
      const {
        actionId,
        fieldPath,
        optionsSourceId,
        sessionId,
        limit,
        query,
        ...context
      } = args;
      const input: Record<string, unknown> = { ...context };
      if (actionId) input.actionId = actionId;
      if (fieldPath) input.fieldPath = fieldPath;
      if (optionsSourceId) input.optionsSourceId = optionsSourceId;
      if (sessionId) input.sessionId = sessionId;
      if (typeof limit === 'number') input.limit = limit;
      if (typeof query === 'string') input.query = query;

      const result = await params.executor.execute(
        'action.options.resolve',
        input,
        {
          defaultSessionId,
          surface,
          ...(surface === 'agent' ? { authority: 'account_automation' as const } : {}),
          actionsSettings: readActionsSettings(),
        },
      );
      if (!result.ok) {
        return {
          ok: false,
          errorCode: result.errorCode,
          error: result.error,
          ...(result.details === undefined ? {} : { details: result.details }),
        };
      }

      const payload = readActionOptionsPayload(result.result);
      if (!payload) {
        return {
          ok: false,
          errorCode: 'action_options_resolve_failed',
          error: 'Options source resolution failed',
        };
      }

      return {
        ok: true,
        result: payload,
      } satisfies DynamicActionOptionsBridgeResult;
    },
    isActionEnabled,
  };
}
