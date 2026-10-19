import { parseQualifiedPluginContributionKey } from '../plugins/contributionIdentity.js';
import { BackendTargetKeyV2Schema, parseBackendTargetKeyV2 } from '../backends/targets/backendTargetRefV2.js';
import { resolveRoleSelectionV1, type ResolveRoleSelectionV1Input, type RoleSelectionRefusalV1 } from '../prompts/roles/resolveRoleSelectionV1.js';
import type { ResolvedRoleV1 } from '../prompts/roles/rolesV1.js';
import type { JsonValue } from '../json/strictJsonValue.js';
import { readWorkflowValuePathV1 } from './workflowReferenceV1.js';
import { WorkflowLiteralEngineSelectionV1Schema } from './workflowV1.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import type { WorkflowMaterializedLeafV1 } from './workflowDefinitionV1.js';
import { normalizeExecutableParticipantSelectionV1 } from '../discussions/executableParticipants.js';
import type { WorkflowStepExecutionSelection, WorkflowStepSelectionV1, WorkflowLeafExecutionTargetV1 } from './workflowV1.js';
export { WorkflowLeafExecutionTargetV1Schema, WorkflowEngineSelectionV1Schema, WorkflowStepSelectionV1Schema,
  type WorkflowLeafExecutionTargetV1, type WorkflowEngineSelectionV1, type WorkflowStepSelectionV1 } from './workflowV1.js';

export type WorkflowResolvedStepSelectionV1 = Omit<WorkflowStepSelectionV1, 'engine' | 'participant' | 'executionTarget'>;

/** Host context for the default engine; bindings stay in the existing leaf selection. */
export type WorkflowRoleSelectionContextV1 = Omit<ResolveRoleSelectionV1Input, 'roleId'> & Readonly<{
  defaultConnectedServices?: WorkflowStepExecutionSelection['connectedServices'];
}>;

export type ResolveWorkflowStepSelectionV1Input = Readonly<{
  defaults: WorkflowStepSelectionV1;
  step?: WorkflowStepSelectionV1;
  roleSelection?: WorkflowRoleSelectionContextV1;
  runExecutionTarget?: WorkflowLeafExecutionTargetV1;
  producerExecutionTarget?: WorkflowLeafExecutionTargetV1;
  /** Value-only editor projection: roles and from-step targets stay unresolved until admission. */
  purpose?: 'authoring';
  inputs?: Readonly<Record<string, JsonValue>>;
  itemValue?: JsonValue;
}>;
export type ResolveWorkflowStepSelectionV1Result = Readonly<{
  selection: WorkflowResolvedStepSelectionV1;
  executionTarget?: WorkflowLeafExecutionTargetV1;
  role?: ResolvedRoleV1;
}>;
export type WorkflowStepSelectionRefusalV1 = RoleSelectionRefusalV1 | Readonly<{ code: 'invalid_input' }>;

export class WorkflowStepSelectionErrorV1 extends Error {
  readonly code: WorkflowStepSelectionRefusalV1['code'];

  constructor(readonly refusal: WorkflowStepSelectionRefusalV1) {
    super(refusal.code);
    this.name = 'WorkflowStepSelectionErrorV1';
    this.code = refusal.code;
  }
}

/** Invocation admission can choose only a concrete engine already approved in this leaf. */
export function listWorkflowAcceptedLeafSelectionsV1(leaf: WorkflowMaterializedLeafV1): readonly WorkflowMaterializedLeafV1[] {
  const participants = leaf.participantBindings ? leaf.participantBindings.selections.map(selected => ({ ...leaf,
    participant: selected.participant, selection: selected.selection, executionTarget: selected.executionTarget,
    role: selected.role })) : [leaf];
  const engines = participants.flatMap(participantLeaf => participantLeaf.engineBindings
    ? participantLeaf.engineBindings.selections.map(selected => ({ ...participantLeaf,
      selection: selected.selection, executionTarget: selected.executionTarget, role: selected.role }))
    : [participantLeaf]);
  return leaf.sessionBindings ? engines.flatMap(engine => leaf.sessionBindings!.targets.map(target => ({ ...engine,
    selection: { ...engine.selection, conversation: { kind: 'existing_session' as const,
      sessionId: target.address.sessionId, machineId: target.machineId } } }))) : engines;
}

/** Resolve the current lexical value without consulting a mutable catalog or role default. */
export function resolveWorkflowAcceptedStepSelectionV1(leaf: WorkflowMaterializedLeafV1, itemValue?: JsonValue,
  inputs?: Readonly<Record<string, JsonValue>>): WorkflowMaterializedLeafV1 {
  if (leaf.participantBindings) {
    const reference = leaf.participantBindings.reference;
    const raw = reference.kind === 'item' ? itemValue : inputs?.[reference.name];
    const selectedValue = raw === undefined ? undefined : readWorkflowValuePathV1(raw, reference.path ?? []);
    const participant = normalizeExecutableParticipantSelectionV1(selectedValue);
    const selected = participant && leaf.participantBindings.selections.find(candidate => sameStrictJsonValue(candidate.value, participant));
    if (!selected) throw new WorkflowStepSelectionErrorV1({ code: 'invalid_input' });
    leaf = { ...leaf, participant: selected.participant, selection: selected.selection,
      executionTarget: selected.executionTarget, role: selected.role };
  }
  if (leaf.sessionBindings) {
    const value = inputs?.[leaf.sessionBindings.inputName];
    const target = leaf.sessionBindings.targets.find(target => sameStrictJsonValue(target.address, value));
    if (!target) throw new WorkflowStepSelectionErrorV1({ code: 'invalid_input' });
    leaf = { ...leaf, selection: { ...leaf.selection, conversation: { kind: 'existing_session',
      sessionId: target.address.sessionId, machineId: target.machineId } } };
  }
  if (!leaf.engineBindings) return leaf;
  const reference = leaf.engineBindings.reference;
  const raw = reference.kind === 'item' ? itemValue : inputs?.[reference.name];
  const value = raw === undefined ? undefined : readWorkflowValuePathV1(raw, reference.path ?? []);
  const parsed = WorkflowLiteralEngineSelectionV1Schema.safeParse(value);
  const selected = parsed.success ? leaf.engineBindings.selections.find(candidate => sameStrictJsonValue(candidate.value, parsed.data)) : undefined;
  if (!selected) throw new WorkflowStepSelectionErrorV1({ code: 'invalid_input' });
  return { ...leaf, selection: { ...selected.selection,
    ...(leaf.sessionBindings ? { conversation: leaf.selection.conversation } : {}) }, executionTarget: selected.executionTarget, role: selected.role };
}

// Value-only authoring consumers preserve the flat Session selection type.
export function resolveWorkflowStepSelectionV1(input: Readonly<{
  defaults: WorkflowStepExecutionSelection & { engine?: never; executionTarget?: never };
  step?: WorkflowStepExecutionSelection & { engine?: never; executionTarget?: never };
}>): Omit<ResolveWorkflowStepSelectionV1Result, 'selection'> & Readonly<{ selection: WorkflowStepExecutionSelection }>;
export function resolveWorkflowStepSelectionV1(input: ResolveWorkflowStepSelectionV1Input): ResolveWorkflowStepSelectionV1Result;
export function resolveWorkflowStepSelectionV1(input: ResolveWorkflowStepSelectionV1Input): ResolveWorkflowStepSelectionV1Result {
  let engine = input.step?.engine ?? input.defaults.engine;
  if (engine && 'kind' in engine && input.purpose !== 'authoring') {
    const value = engine.kind === 'input' ? input.inputs?.[engine.name] : input.itemValue;
    const selected = value === undefined ? undefined : readWorkflowValuePathV1(value, engine.path ?? []);
    const parsed = WorkflowLiteralEngineSelectionV1Schema.safeParse(selected);
    if (!parsed.success) throw new WorkflowStepSelectionErrorV1({ code: 'invalid_input' });
    engine = parsed.data;
  }
  const { engine: defaultEngine, participant: defaultParticipant, executionTarget: defaultTarget, ...defaults } = input.defaults;
  const { engine: stepEngine, participant: stepParticipant, executionTarget: stepTarget, ...step } = input.step ?? {};
  const participant = stepParticipant ?? defaultParticipant;
  // Optional fields are unset when undefined; explicit null remains an override.
  for (const key of Object.keys(step) as (keyof typeof step)[]) {
    if (step[key] === undefined) delete step[key];
  }
  let selection: WorkflowResolvedStepSelectionV1 = input.step === undefined && engine === undefined && participant === undefined && defaultTarget === undefined
    ? input.defaults
    : { ...defaults, ...step };
  let role: ResolvedRoleV1 | undefined;

  if (engine !== undefined) {
    // Work on our own object: authoring readers can retain defaults by identity.
    selection = { ...selection };
    delete selection.agentTarget;
    delete selection.modelSelection;
    const config = selection.sessionConfigOptionOverrides;
    if (config?.overrides.reasoning_effort !== undefined) {
      const { reasoning_effort, ...overrides } = config.overrides;
      selection.sessionConfigOptionOverrides = { ...config, overrides };
    }

    let effort: string | undefined;
    if ('role' in engine && input.purpose !== 'authoring') {
      const resolved = resolveRoleSelectionV1({ ...input.roleSelection, roleId: engine.role });
      if (!resolved.ok) throw new WorkflowStepSelectionErrorV1(resolved.refusal);
      role = resolved.selection;
      const targetKey = BackendTargetKeyV2Schema.safeParse(role.engine?.agentTargetKey);
      const target = targetKey.success ? parseBackendTargetKeyV2(targetKey.data) : null;
      const identity = target?.kind === 'agent' ? target.identity : parseQualifiedPluginContributionKey(role.engine?.agentTargetKey);
      if (identity === null || role.engine === undefined) {
        throw new WorkflowStepSelectionErrorV1({ code: 'target_unavailable', reason: 'engine_unavailable', roleId: role.roleId });
      }
      selection.agentTarget = target?.kind === 'agent' ? target : { kind: 'agent', identity };
      const defaultConnectedServices = input.roleSelection?.defaultConnectedServices;
      if (selection.connectedServices === undefined && defaultConnectedServices !== undefined
        && role.engine.agentTargetKey === input.roleSelection?.defaultEngine?.agentTargetKey) {
        selection.connectedServices = defaultConnectedServices;
      }
      if (role.engine.modelId !== undefined) {
        selection.modelSelection = {
          v: 1, updatedAt: 0,
          ref: { agentTargetKey: role.engine.agentTargetKey, providerConnectionId: null, modelId: role.engine.modelId },
        };
      }
      if (role.profileId !== undefined && selection.profileId === undefined) selection.profileId = role.profileId;
      effort = role.engine.effort;
    } else if ('agentTarget' in engine) {
      selection.agentTarget = engine.agentTarget;
      if (engine.modelSelection !== undefined) selection.modelSelection = engine.modelSelection;
      effort = engine.effort;
    }
    if (effort !== undefined) {
      const inherited = selection.sessionConfigOptionOverrides;
      selection.sessionConfigOptionOverrides = {
        v: 1, updatedAt: inherited?.updatedAt ?? 0,
        overrides: { ...inherited?.overrides, reasoning_effort: { value: effort, updatedAt: 0 } },
      };
    }
  }
  if (participant !== undefined) {
    if (input.purpose !== 'authoring') {
      const raw = participant.kind === 'input' ? input.inputs?.[participant.name] : input.itemValue;
      const selected = raw === undefined ? undefined : readWorkflowValuePathV1(raw, participant.path ?? []);
      if (!normalizeExecutableParticipantSelectionV1(selected)) throw new WorkflowStepSelectionErrorV1({ code: 'invalid_input' });
    }
    selection = { ...selection };
    delete selection.agentTarget;
    delete selection.modelSelection;
  }

  const runTarget = input.runExecutionTarget ?? defaultTarget;
  let executionTarget: WorkflowLeafExecutionTargetV1 | undefined;
  // Value displays have no admission context. Admission supplies the target to
  // resolve from-step classes; the value-only call never guesses a producer's class.
  if (input.purpose !== 'authoring' && (participant !== undefined || runTarget !== undefined || stepTarget !== undefined || role !== undefined
    || input.producerExecutionTarget !== undefined
    || selection.conversation?.kind === 'origin_session' || selection.conversation?.kind === 'existing_session')) {
    const conversation = selection.conversation;
    let boundTarget: WorkflowLeafExecutionTargetV1 | undefined;
    if (conversation?.kind === 'origin_session' || conversation?.kind === 'existing_session') {
      boundTarget = { kind: 'session' };
    } else if (conversation?.kind === 'from_step') {
      if (input.producerExecutionTarget === undefined) {
        throw new WorkflowStepSelectionErrorV1({ code: 'invalid_input' });
      }
      boundTarget = input.producerExecutionTarget;
    }
    if (stepTarget !== undefined && boundTarget !== undefined && stepTarget.kind !== boundTarget.kind) {
      throw new WorkflowStepSelectionErrorV1({ code: 'invalid_input' });
    }
    executionTarget = participant !== undefined ? { kind: 'session' } : stepTarget ?? boundTarget
      ?? (role === undefined ? undefined : { kind: role.runsAs.kind === 'session' ? 'session' : 'detached_run' })
      ?? runTarget;
    if (input.step?.conversation?.kind === 'shared_run' && runTarget !== undefined && executionTarget?.kind !== runTarget.kind) {
      throw new WorkflowStepSelectionErrorV1({ code: 'invalid_input' });
    }
  }
  return { selection, ...(role === undefined ? {} : { role }), ...(executionTarget === undefined ? {} : { executionTarget }) };
}
