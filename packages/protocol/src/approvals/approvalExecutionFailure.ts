import type { ActionExecuteFailure } from '../actions/actionExecutionResult.js';
import { getActionSpec } from '../actions/actionSpecs.js';
import { isFilesystemActionId } from '../actions/filesystemActionFamily.js';
import { PROJECT_ACTION_INPUT_SCHEMAS_V1 } from '../actions/projectActionFamily.js';
import {
  ProjectWorkerNoAcceptanceFailureDetailsV1Schema,
  readProjectWorkerNoAcceptanceFailureV1,
} from '../actions/projectWorkerRefusal.js';
import {
  SavedSecretResourceActionErrorV1Schema,
  SharedSavedSecretDeleteInputV1Schema,
} from '../account/settings/savedSecretResourceActionsV1.js';
import { HomeAccountDeleteInputV1Schema } from '../home/governance/accounts.js';
import { HomeGovernanceErrorV1Schema } from '../home/governance/errors.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { AccountSettingsMutationInvalidResultSchema } from '../account/settings/accountSettingMutationV1.js';
import { SettingsDeclarationActionInputSchemasV1 } from '../actions/settingsDeclarationActionFamily.js';
import { readAccountSettingDeclarationV1 } from '../actions/accountSettingDeclarations.js';
import {
  parseSessionBoardActionPortResultV1,
  parseStoredSessionBoardActionFailureV1,
} from '../sessions/board/actions.js';
import { SessionBoardActionIdV1Schema } from '../sessions/board/actionIds.js';
import { MachinePresetActionIdV1Schema, MachinePresetActionOutputSchemasV1 } from '../machines/managed/machinePresetActionsV1.js';
import { ManagedMachineActionIdV1Schema, ManagedMachineActionOutputSchemasV1 } from '../machines/managed/actionsV1.js';
import { MachinePoolResolveResultV1Schema } from '../machines/pools/v1.js';
import { ProjectWorkerActionOutputSchemasV1 } from '../actions/specs/projectWorkers.js';
import { ActionOperationCancelV1ResponseSchema } from '../actions/operations/v1.js';
import { ApprovalStaleFailureDetailsSchema } from './approvalStaleReason.js';
import type {
  ApprovalExecutionV2,
  ApprovalRequest,
  ApprovalRequestV2,
} from './approvalRequestV1.js';
export { ApprovalStaleReasonSchema, ApprovalStaleFailureDetailsSchema, type ApprovalStaleReason } from './approvalStaleReason.js';

function parseStrictApprovalFailure(input: Readonly<{
  request: ApprovalRequestV2;
  failure: ActionExecuteFailure;
}>, storedRead = false): ActionExecuteFailure | null {
  if (input.failure.errorCode === 'approval_stale') {
    const details = (storedRead ? createStoredReadSchema(ApprovalStaleFailureDetailsSchema)
      : ApprovalStaleFailureDetailsSchema).safeParse(input.failure.details);
    return details.success ? { ...input.failure, details: details.data } : null;
  }
  if (input.request.actionId === 'settings.set') {
    if (input.failure.errorCode !== 'account_settings_invalid') return null;
    const schema = SettingsDeclarationActionInputSchemasV1['settings.set'];
    const args = (storedRead ? createStoredReadSchema(schema) : schema).safeParse(input.request.actionArgs);
    if (!args.success || args.data.target || !readAccountSettingDeclarationV1(args.data.anchor)) return null;
    const details = (storedRead ? createStoredReadSchema(AccountSettingsMutationInvalidResultSchema)
      : AccountSettingsMutationInvalidResultSchema).safeParse(input.failure.details);
    return details.success ? { ...input.failure, details: details.data } : null;
  }
  const projectActionId = input.request.actionId;
  if (projectActionId === 'projects.script.run' || projectActionId === 'projects.compute.exec') {
    const inputSchema = PROJECT_ACTION_INPUT_SCHEMAS_V1[projectActionId];
    const args = (storedRead ? createStoredReadSchema(inputSchema) : inputSchema)
      .safeParse(input.request.actionArgs);
    if (!args.success || args.data.workspace.serverId !== input.request.executionOriginV1.serverId) return null;
    const details = (storedRead
      ? createStoredReadSchema(ProjectWorkerNoAcceptanceFailureDetailsV1Schema)
      : ProjectWorkerNoAcceptanceFailureDetailsV1Schema).safeParse(input.failure.details);
    return details.success
      ? readProjectWorkerNoAcceptanceFailureV1({ ...input.failure, details: details.data })
      : null;
  }
  const removal = input.request.actionId === 'secrets.shared.delete'
    ? {
      input: SharedSavedSecretDeleteInputV1Schema,
      failure: SavedSecretResourceActionErrorV1Schema,
      code: 'managed_resources_review_required',
    }
    : input.request.actionId === 'home.accounts.delete'
      ? {
        input: HomeAccountDeleteInputV1Schema,
        failure: HomeGovernanceErrorV1Schema,
        code: 'account_erasure_managed_resources_review_required',
      }
      : null;
  if (removal) {
    if (input.failure.errorCode !== removal.code) return null;
    const args = (storedRead ? createStoredReadSchema(removal.input) : removal.input)
      .safeParse(input.request.actionArgs);
    const details = (storedRead ? createStoredReadSchema(removal.failure) : removal.failure)
      .safeParse(input.failure.details);
    return args.success && details.success && details.data.error === removal.code
      ? { ...input.failure, details: details.data }
      : null;
  }
  const actionId = SessionBoardActionIdV1Schema.safeParse(input.request.actionId);
  if (!actionId.success) return null;
  const parsed = (storedRead ? parseStoredSessionBoardActionFailureV1 : parseSessionBoardActionPortResultV1)(
    actionId.data,
    input.request.actionArgs,
    input.failure,
    {
      ...(input.request.executionOriginV1.sessionId
        ? { expectedSessionId: input.request.executionOriginV1.sessionId }
        : {}),
      expectedServerId: input.request.executionOriginV1.serverId,
    },
  );
  return parsed.success && parsed.kind === 'failure' ? parsed.data : null;
}

/**
 * Project one failed execution into durable approval history. Only details
 * accepted by the exact Action family's strict, request-bound parser survive.
 * Arbitrary errors and opaque detail bags remain live-only.
 */
export function projectApprovalExecutionFailureV2(input: Readonly<{
  request: ApprovalRequestV2;
  failure: ActionExecuteFailure;
  executedAtMs: number;
}>): ApprovalExecutionV2 {
  const strictFailure = parseStrictApprovalFailure(input);
  return {
    executedAtMs: input.executedAtMs,
    ok: false,
    errorCode: input.failure.errorCode,
    error: input.failure.error,
    ...(strictFailure?.details !== undefined ? { details: strictFailure.details } : {}),
  };
}

/**
 * A successfully executed Action may still refuse its domain effect.
 * Interpret only exact family outputs; arbitrary Action data can also have a kind or status.
 * This is a read projection, not a rewrite of the durable execution receipt.
 */
function readDomainExecutionFailure(request: ApprovalRequest): ActionExecuteFailure | null {
  if (isFilesystemActionId(request.actionId)) {
    const schema = getActionSpec(request.actionId).outputSchema;
    if (!schema) return null;
    const parsed = createStoredReadSchema(schema).safeParse(request.execution?.result);
    if (!parsed.success) {
      return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
    }
    const result = parsed.data;
    if (!result || typeof result !== 'object' || !('success' in result) || result.success !== false) return null;
    const errorCode = 'errorCode' in result && typeof result.errorCode === 'string' && result.errorCode.trim()
      ? result.errorCode : 'filesystem_operation_failed';
    const error = 'error' in result && typeof result.error === 'string' && result.error.trim()
      ? result.error : errorCode;
    return { ok: false, errorCode, error };
  }
  const preset = MachinePresetActionIdV1Schema.safeParse(request.actionId);
  const managed = ManagedMachineActionIdV1Schema.safeParse(request.actionId);
  const mutationId = request.actionId === 'machines.worker.policy.set'
    || request.actionId === 'projects.worker.preferences.set'
    || request.actionId === 'projects.worker.preferences.reset'
    || request.actionId === 'projects.service.placement.set'
    ? request.actionId : null;
  const schema = preset.success ? MachinePresetActionOutputSchemasV1[preset.data]
    : managed.success ? ManagedMachineActionOutputSchemasV1[managed.data]
      : request.actionId === 'machines.pools.resolve' ? MachinePoolResolveResultV1Schema
        : mutationId ? ProjectWorkerActionOutputSchemasV1[mutationId]
          : request.actionId === 'action.operations.cancel' ? ActionOperationCancelV1ResponseSchema : null;
  if (!schema) return null;
  const parsed = createStoredReadSchema(schema).safeParse(request.execution?.result);
  if (!parsed.success) return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
  const result: unknown = parsed.data;
  if (mutationId && result && typeof result === 'object' && 'status' in result && typeof result.status === 'string') {
    const errorCode = result.status;
    return errorCode === 'applied' || errorCode === 'satisfied' || errorCode === 'unchanged'
      ? null : { ok: false, errorCode, error: errorCode, details: result };
  }
  if (!result || typeof result !== 'object' || !('kind' in result)) return null;
  if (request.actionId === 'action.operations.cancel' && (result.kind === 'unsupported' || result.kind === 'not_found')) {
    return { ok: false, errorCode: result.kind, error: result.kind, details: result };
  }
  const errorCode = result.kind === 'refused' && 'code' in result && typeof result.code === 'string'
    ? result.code
    : result.kind === 'conflict' ? preset.success ? 'conflict' : 'intent_changed'
      : result.kind === 'unavailable' && 'reason' in result && typeof result.reason === 'string'
        ? result.reason : null;
  return errorCode ? { ok: false, errorCode, error: errorCode, details: result } : null;
}

/** Read terminal history without trusting legacy or unvalidated opaque fields. */
export function readApprovalExecutionFailure(
  request: ApprovalRequest,
): ActionExecuteFailure | null {
  const execution = request.execution;
  if (!execution) return null;
  if (execution.ok === true) return readDomainExecutionFailure(request);
  if (execution.ok !== false) return null;
  const errorCode = typeof execution.errorCode === 'string' && execution.errorCode.trim().length > 0
    ? execution.errorCode
    : 'approval_execution_failed';
  const error = typeof execution.error === 'string' && execution.error.trim().length > 0
    ? execution.error
    : errorCode;
  const failure: ActionExecuteFailure = { ok: false, errorCode, error };
  if (request.v !== 2 || execution.details === undefined) return failure;
  return parseStrictApprovalFailure({
    request,
    failure: { ...failure, details: execution.details },
  }, true) ?? failure;
}
