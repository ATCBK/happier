import { getActionSpec, resolveActionExecutionPlacementForInput } from '@happier-dev/protocol/actions/actionSpecs';
import { readLocalServiceControlActionRequest } from '@happier-dev/protocol/actions/specs/localServices';
import { ManagedAcquireInputV1Schema, resolveManagedAcquireReviewV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { SessionSpawnNewAgentAuthoringInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import type { ActionExecuteResult, ActionExecutorContext, ExternalActionTargetV1, ActionId } from '@happier-dev/protocol/actions';
import { readActionSessionTargetField } from '@happier-dev/protocol/actions/executor/sessionTargets';
import { normalizeSessionTargetV1 } from '@happier-dev/protocol/actions/sessionTargetV1';
import { PluginSettingsAdministrationActionIdV1Schema, resolvePluginSettingsAdministrationTargetV1 } from '@happier-dev/protocol/plugins/settingsAdministration';

/**
 * The external ingress has one deliberately bounded selector vocabulary. It
 * reads canonical *parsed* Action input, never raw passthrough fields, so a
 * caller cannot steer placement through an incidental similarly named value.
 * New selector-shaped Action input must extend this owner and its architecture
 * test rather than gaining a route-local exception.
 */
const NESTED_SESSION_SELECTOR_ACTION_IDS = new Set<ActionId>([
  'session.continue_with_replay',
]);

// Only declared execution targets participate. Other nested Machine ids can
// describe SOURCE data, reviewed evidence, or a resource on another Machine.
const NESTED_MACHINE_SELECTOR_FIELDS: Readonly<Partial<Record<ActionId, string>>> = {
  'session.spawn_new': 'executionTarget',
  'projects.worker.status': 'destination',
  'daemon.filesystem.copy': 'destination',
  'projects.inspect': 'workspace',
  'projects.manifest.update': 'workspace',
  'projects.prepare': 'workspace',
  'artifact.publish_from_file': 'workspace',
  'peerMediation.observability.subscribe': 'scope',
  'peerMediation.observability.unsubscribe': 'scope',
};

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function parseActionTargetInput(actionId: ActionId, input: unknown) {
  // Target selection precedes Session inheritance and creation admission. Read
  // the same strict authoring shape without resolving either launch choice here.
  const schema = actionId === 'session.spawn_new'
    ? SessionSpawnNewAgentAuthoringInputV2Schema : getActionSpec(actionId).inputSchema;
  return schema.safeParse(input);
}

function readSessionSelectorIds(
  actionId: ActionId,
  input: Readonly<Record<string, unknown>>,
): readonly string[] {
  const selectors = [
    readNonEmptyString(input.sessionId),
    readNonEmptyString(input.parentSessionId),
  ];
  if (NESTED_SESSION_SELECTOR_ACTION_IDS.has(actionId)) {
    selectors.push(readNonEmptyString(asRecord(input.replay)?.previousSessionId));
  }
  return selectors.filter((selector): selector is string => selector !== null);
}

/** Reads semantic routing selectors from schema-admitted Action input only. */
export function readMachineSelectorIds(actionId: ActionId, input: Readonly<Record<string, unknown>>): readonly string[] {
  const acquire = actionId === 'machines.managed.acquire' ? ManagedAcquireInputV1Schema.safeParse(input) : null;
  const controllerMachineId = acquire?.success ? resolveManagedAcquireReviewV1(acquire.data).controller.machineId
    : actionId === 'machines.provisioners.check' || actionId === 'machines.provisioners.options'
      ? readNonEmptyString(asRecord(input.controller)?.machineId) : null;
  const nestedField = NESTED_MACHINE_SELECTOR_FIELDS[actionId];
  const settingsActionId = PluginSettingsAdministrationActionIdV1Schema.safeParse(actionId);
  const settingsTarget = settingsActionId.success
    ? resolvePluginSettingsAdministrationTargetV1(settingsActionId.data, input) : null;
  const selectors = [
    controllerMachineId,
    // Key preparation executes on the explicitly selected trusted key holder.
    // Its qualified machineId addresses the managed Resource, not that holder.
    actionId === 'machines.access.prepareKeys' ? null : readNonEmptyString(input.machineId),
    nestedField ? readNonEmptyString(asRecord(input[nestedField])?.machineId) : null,
    settingsTarget?.kind === 'daemon' ? settingsTarget.machineId : null,
    readLocalServiceControlActionRequest(actionId, input)?.target.machineId ?? null,
  ];
  return selectors.filter((selector): selector is string => selector !== null);
}

function isTitleOnlySessionOpen(
  actionId: ActionId,
  input: Readonly<Record<string, unknown>>,
  sessionSelectorIds: readonly string[],
): boolean {
  return actionId === 'session.open'
    && sessionSelectorIds.length === 0
    && readNonEmptyString(input.sessionTitle) !== null;
}

function targetNotLocal(): ActionExecuteResult {
  return { ok: false, errorCode: 'target_not_local', error: 'target_not_local' };
}

function targetRequired(): ActionExecuteResult {
  return { ok: false, errorCode: 'target_required', error: 'target_required' };
}

export type ExternalActionTargetReconciliation =
  | Readonly<{
      kind: 'ready';
      target: ExternalActionTargetV1 | undefined;
      context: Pick<
        ActionExecutorContext,
        'defaultSessionId' | 'executionRunTargetMachineId'
      >;
      executionRunRequiresMachineTarget: boolean;
    }>
  | Readonly<{ kind: 'rejected'; execution: ActionExecuteResult }>;

/**
 * Reconciles the public envelope route metadata with the canonical parsed
 * Action input before the daemon asks its target resolver for a final locality
 * proof. This is intentionally ingress-owned: Action owners keep their input
 * semantics, while the transport owns only whether that input may select a
 * different daemon or Session than the verified route target.
 */
export function reconcileExternalActionTarget(input: Readonly<{
  actionId: ActionId;
  rawInput: unknown;
  target: ExternalActionTargetV1 | undefined;
  currentMachineId: string;
}>): ExternalActionTargetReconciliation {
  const spec = getActionSpec(input.actionId);
  const parsed = parseActionTargetInput(input.actionId, input.rawInput);

  // The canonical executor owns malformed Action input errors. Do not create a
  // second parser/error vocabulary at ingress; only route validated input.
  if (!parsed.success) {
    return {
      kind: 'ready',
      target: input.target,
      context: {},
      executionRunRequiresMachineTarget: false,
    };
  }

  const parsedInput = asRecord(parsed.data);
  if (!parsedInput) {
    return {
      kind: 'ready',
      target: input.target,
      context: {},
      executionRunRequiresMachineTarget: false,
    };
  }

  if (spec.sessionTarget) {
    const target = readActionSessionTargetField(parsedInput, spec.sessionTarget.field);
    // The strict Action schema has admitted the operand. A selector is intent
    // for the shared resolver, not an exact Session transport destination.
    let selectorIntent = false;
    try { selectorIntent = target !== undefined && target !== null && typeof normalizeSessionTargetV1(target) !== 'string'; }
    catch { /* The canonical Action executor owns malformed shorthand. */ }
    if (selectorIntent) {
      if (input.target?.kind === 'session') return { kind: 'rejected', execution: targetRequired() };
      return { kind: 'ready', target: input.target, context: {}, executionRunRequiresMachineTarget: false };
    }
  }

  const sessionSelectorIds = readSessionSelectorIds(input.actionId, parsedInput);
  const distinctSessionSelectorIds = [...new Set(sessionSelectorIds)];
  if (distinctSessionSelectorIds.length > 1) {
    return { kind: 'rejected', execution: targetNotLocal() };
  }

  if (isTitleOnlySessionOpen(input.actionId, parsedInput, sessionSelectorIds)) {
    return { kind: 'rejected', execution: targetRequired() };
  }

  const isExecutionRun = input.actionId.startsWith('execution.run.');
  const executionPlacement = resolveActionExecutionPlacementForInput(spec, parsed.data);
  const canDeriveSessionTarget = executionPlacement === 'session' || executionPlacement === 'client' || isExecutionRun;
  // `action.invoke` is machine-placed so account- and machine-scoped
  // contributions can run without a Session. Its nested plugin input is never
  // a routing selector, but an explicit envelope Session target is already
  // host-owned route metadata and may establish the invocation context.
  const isContributedActionInvocation = input.actionId === 'action.invoke';
  const bindsEnvelopeSession = isContributedActionInvocation || executionPlacement === 'client' || input.actionId.startsWith('computer.');
  const sessionSelectorId = distinctSessionSelectorIds[0] ?? null;

  if (executionPlacement === 'machine') {
    const machineSelectorIds = readMachineSelectorIds(input.actionId, parsedInput);
    if (machineSelectorIds.some((machineId) => machineId !== input.currentMachineId)) {
      return { kind: 'rejected', execution: targetNotLocal() };
    }
  }

  if (input.target?.kind === 'session') {
    if (!canDeriveSessionTarget && !bindsEnvelopeSession) {
      return { kind: 'rejected', execution: targetRequired() };
    }
    if (!bindsEnvelopeSession && !sessionSelectorId) {
      return { kind: 'rejected', execution: targetRequired() };
    }
    if (sessionSelectorId && sessionSelectorId !== input.target.sessionId) {
      return { kind: 'rejected', execution: targetNotLocal() };
    }
    return {
      kind: 'ready',
      target: input.target,
      context: { defaultSessionId: input.target.sessionId },
      executionRunRequiresMachineTarget: false,
    };
  }

  if (canDeriveSessionTarget && sessionSelectorId) {
    // A local-machine target is compatible only after the canonical Session
    // resolver proves this same daemon still owns the selected Session.
    return {
      kind: 'ready',
      target: { kind: 'session', sessionId: sessionSelectorId },
      context: { defaultSessionId: sessionSelectorId },
      executionRunRequiresMachineTarget: false,
    };
  }

  if (executionPlacement === 'session') {
    return { kind: 'rejected', execution: targetRequired() };
  }

  return {
    kind: 'ready',
    target: input.target,
    context: {},
    executionRunRequiresMachineTarget: isExecutionRun,
  };
}

/** Caller-side Machine selection uses the same parsed selector/locality owner as daemon ingress. */
export function resolveExternalActionMachineTarget(input: Readonly<{
  actionId: ActionId;
  rawInput: unknown;
  target?: ExternalActionTargetV1;
  fallbackMachineId?: string | null;
  /** Authenticated Session ownership, when the semantic Action addresses a linked Session. */
  ownerMachineId?: string | null;
}>): Readonly<{ kind: 'ready'; machineId: string }> | Readonly<{ kind: 'rejected'; execution: ActionExecuteResult }> {
  const parsed = parseActionTargetInput(input.actionId, input.rawInput);
  if (!parsed.success) return { kind: 'rejected', execution: { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' } };
  const machineIds = readMachineSelectorIds(input.actionId, asRecord(parsed.data) ?? {});
  const explicitMachineId = input.target?.kind === 'machine' ? input.target.machineId : null;
  const distinctMachineIds = new Set([...machineIds, ...(explicitMachineId ? [explicitMachineId] : [])]);
  if (distinctMachineIds.size > 1) return { kind: 'rejected', execution: targetNotLocal() };
  const machineId = input.ownerMachineId ?? machineIds[0] ?? explicitMachineId ?? readNonEmptyString(input.fallbackMachineId);
  if (!machineId) return { kind: 'rejected', execution: targetRequired() };
  if (explicitMachineId && explicitMachineId !== machineId) return { kind: 'rejected', execution: targetNotLocal() };
  const reconciliation = reconcileExternalActionTarget({
    actionId: input.actionId, rawInput: parsed.data, target: input.target, currentMachineId: machineId,
  });
  return reconciliation.kind === 'rejected' ? reconciliation : { kind: 'ready', machineId };
}
