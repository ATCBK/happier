import { WorkflowActionInputSchemasV1, WorkflowActionOutputSchemasV1 } from '../../workflows/actionsV1.js';
import { validateWorkflowDefinition } from '../../workflows/workflowValidationV1.js';
import type { WorkflowActionExecute, WorkflowActionExecuteArgs } from './types.js';
import type { WorkflowActionIdV1, WorkflowIngressContextV1 } from '../../workflows/index.js';
import type { WorkflowTriggerActions } from './workflowTriggerActions.js';
import { WorkflowActionFailureV1Schema, type WorkflowActionFailureV1 } from '../../workflows/workflowProgressV1.js';

export type WorkflowActionFailureDiagnosticV1 = Readonly<{
  event: 'workflow_action_failure';
  errorCode: 'storage_unavailable' | 'content_unavailable';
  originalCode: string | null;
  httpStatus: number | null;
  operation: string;
  durationMs: number;
}>;

/** One closed failure projection for both the family and host preparation. */
export function normalizeWorkflowActionThrownError(error: unknown, diagnostic?: Readonly<{
  operation: string;
  durationMs: number;
  emit: (diagnostic: WorkflowActionFailureDiagnosticV1) => void;
}>): WorkflowActionFailureV1 {
  const rawCode = error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code : 'storage_unavailable';
  // The template codec's reasons also drive locked-row listing inside the
  // trigger owner. At the Action boundary they describe unreadable content,
  // not a failure to reach storage.
  const code = rawCode === 'automation_disabled' ? 'ineligible_state'
    : rawCode === 'automation_not_found' ? 'content_unavailable'
    // This is Account-wide preparation, before any role is selected. Keep
    // its specific read failure in content details rather than refusing a role.
    : rawCode === 'account_role_overrides_unavailable' ? 'content_unavailable'
    : rawCode === 'session_key_required' || rawCode === 'encryption_material_unavailable'
    || rawCode === 'encryption_mode_mismatch' || rawCode === 'invalid_template'
    ? 'content_unavailable' : rawCode;
  const details = rawCode === 'account_role_overrides_unavailable' ? { reason: rawCode }
    : error !== null && typeof error === 'object' && 'details' in error ? error.details : undefined;
  const failure = WorkflowActionFailureV1Schema.safeParse({
    ok: false,
    errorCode: code,
    error: error instanceof Error ? error.message : code,
    ...(details !== undefined ? { details } : code === 'target_unavailable'
      ? { details: { code: 'target_unavailable', reason: 'selection_unavailable' } } : {}),
  });
  const result: WorkflowActionFailureV1 = failure.success ? failure.data
    : { ok: false, errorCode: 'storage_unavailable', error: 'storage_unavailable' };
  if ((result.errorCode === 'storage_unavailable'
    || (rawCode === 'account_role_overrides_unavailable' && result.errorCode === 'content_unavailable')) && diagnostic) {
    let originalCode: string | null = null;
    let httpStatus: number | null = null;
    let operation = diagnostic.operation;
    let durationMs = diagnostic.durationMs;
    const seen = new Set<object>();
    for (let cause = error; cause && typeof cause === 'object' && !seen.has(cause);) {
      seen.add(cause);
      if ('code' in cause && typeof cause.code === 'string' && /^[A-Za-z0-9_.:-]+$/.test(cause.code)) originalCode = cause.code;
      if ('response' in cause && cause.response && typeof cause.response === 'object'
        && 'status' in cause.response && typeof cause.response.status === 'number'
        && Number.isInteger(cause.response.status) && cause.response.status >= 100 && cause.response.status <= 599) {
        httpStatus = cause.response.status;
      }
      if ('workflowStorageOperation' in cause && cause.workflowStorageOperation && typeof cause.workflowStorageOperation === 'object') {
        const storage = cause.workflowStorageOperation;
        if ('operation' in storage && typeof storage.operation === 'string' && /^[a-z._-]+$/.test(storage.operation)
          && 'durationMs' in storage && typeof storage.durationMs === 'number' && Number.isFinite(storage.durationMs) && storage.durationMs >= 0) {
          operation = storage.operation;
          durationMs = storage.durationMs;
        }
      }
      cause = 'cause' in cause ? cause.cause : undefined;
    }
    diagnostic.emit({ event: 'workflow_action_failure', errorCode: result.errorCode, originalCode,
      httpStatus, operation, durationMs });
  }
  return result;
}

/** Request validation is not a failure to read private persisted content. */
function parseWorkflowActionInput<T>(schema: Readonly<{ parse: (input: unknown) => T }>, input: unknown): T {
  try {
    return schema.parse(input);
  } catch {
    throw Object.assign(new Error('invalid_input'), { code: 'invalid_input' });
  }
}

type DefinitionActions = Readonly<{
  list: (input: ReturnType<typeof WorkflowActionInputSchemasV1['workflow.definition.list']['parse']>) => Promise<WorkflowActionResult>;
  get: (input: ReturnType<typeof WorkflowActionInputSchemasV1['workflow.definition.get']['parse']>) => Promise<WorkflowActionResult>;
  create: (input: ReturnType<typeof WorkflowActionInputSchemasV1['workflow.definition.create']['parse']>, context?: WorkflowIngressContextV1,
    caller?: WorkflowActionExecuteArgs['context']) => Promise<WorkflowActionResult>;
  update: (input: ReturnType<typeof WorkflowActionInputSchemasV1['workflow.definition.update']['parse']>, context?: WorkflowIngressContextV1,
    caller?: WorkflowActionExecuteArgs['context']) => Promise<WorkflowActionResult>;
  edit: (input: ReturnType<typeof WorkflowActionInputSchemasV1['workflow.definition.edit']['parse']>, context?: WorkflowIngressContextV1,
    caller?: WorkflowActionExecuteArgs['context']) => Promise<WorkflowActionResult>;
  delete: (input: ReturnType<typeof WorkflowActionInputSchemasV1['workflow.definition.delete']['parse']>,
    caller?: WorkflowActionExecuteArgs['context']) => Promise<WorkflowActionResult>;
  importDocument: (input: ReturnType<typeof WorkflowActionInputSchemasV1['workflow.definition.import']['parse']>, context?: WorkflowIngressContextV1) => Promise<WorkflowActionResult>;
  exportDocument: (input: ReturnType<typeof WorkflowActionInputSchemasV1['workflow.definition.export']['parse']>) => Promise<WorkflowActionResult>;
}>;

type RunActionId = Extract<WorkflowActionIdV1, `workflow.run.${string}`>;
type RunActionArgs = { [TActionId in RunActionId]: WorkflowActionExecuteArgs<TActionId> }[RunActionId];
type WorkflowActionResult = Awaited<ReturnType<WorkflowActionExecute>>;

function isWorkflowRunActionArgs(args: WorkflowActionExecuteArgs): args is RunActionArgs {
  return args.actionId.startsWith('workflow.run.');
}

export type WorkflowRunActionOwner = Readonly<{
  execute: (args: RunActionArgs, context?: WorkflowIngressContextV1) => Promise<WorkflowActionResult>;
}>;

type WorkflowTargetValidation = Readonly<{
  targetValidation: 'checked' | 'unavailable';
  targetIssues?: ReadonlyArray<Readonly<{
    code: 'target_unavailable'; path: string; message: string; severity: 'error' | 'warning';
  }>>;
}>;

/**
 * The shared workflow-family adapter for the canonical Action
 * executor. Run semantics remain in the injected origin-neutral Run owner;
 * definition persistence remains in the Account Artifact owner.
 */
export function createWorkflowActionExecutor(deps: Readonly<{
  onFailureDiagnostic?: (diagnostic: WorkflowActionFailureDiagnosticV1) => void;
  isWorkflowFeatureEnabled: () => Promise<boolean> | boolean;
  definitions: DefinitionActions;
  triggers?: WorkflowTriggerActions;
  runs: WorkflowRunActionOwner;
  resolveIngressContext?: (args: WorkflowActionExecuteArgs) => Promise<WorkflowIngressContextV1 | undefined>;
  resolveTargetValidation?: (args: WorkflowActionExecuteArgs<'workflow.validate'>) => Promise<WorkflowTargetValidation>;
}>): WorkflowActionExecute {
  const execute: WorkflowActionExecute = async (rawArgs) => {
    let featureEnabled = false;
    try {
      featureEnabled = await deps.isWorkflowFeatureEnabled();
    } catch {
      featureEnabled = false;
    }
    if (!featureEnabled) {
      return { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
    }

    const actionId = rawArgs.actionId;
    if (actionId === 'workflow.run.wait'
      && (rawArgs.context.surface === 'agent' || rawArgs.context.surface === 'mcp')
      && rawArgs.context.defaultSessionId
      && rawArgs.input.timeoutSeconds === undefined) {
      return { ok: false, errorCode: 'invalid_input', error: 'invalid_input' };
    }
    const resolvesIngress = actionId === 'workflow.validate'
      || actionId === 'workflow.run.start'
      || actionId === 'workflow.run.resume'
      || actionId === 'workflow.run.invocations.retry'
      || actionId === 'workflow.run.invocations.complete_review'
      || actionId === 'workflow.definition.create'
      || actionId === 'workflow.definition.update'
      || actionId === 'workflow.definition.edit'
      || actionId === 'workflow.definition.import';
    const context = resolvesIngress
      ? await deps.resolveIngressContext?.(rawArgs)
      : undefined;
    if (actionId === 'workflow.validate') {
      const input = parseWorkflowActionInput(WorkflowActionInputSchemasV1[actionId], rawArgs.input);
      const target = input.target
        ? await deps.resolveTargetValidation?.({ ...rawArgs, actionId, input })
          ?? { targetValidation: 'unavailable' as const }
        : { targetValidation: 'not_requested' as const };
      return WorkflowActionOutputSchemasV1[actionId].parse(validateWorkflowDefinition(input.definition, {
        ...(context ? { context } : {}),
        ...target,
      }));
    }
    if (actionId === 'workflow.definition.list') {
      return await deps.definitions.list(parseWorkflowActionInput(WorkflowActionInputSchemasV1[actionId], rawArgs.input));
    }
    if (actionId === 'workflow.definition.get') {
      return await deps.definitions.get(parseWorkflowActionInput(WorkflowActionInputSchemasV1[actionId], rawArgs.input));
    }
    if (actionId === 'workflow.definition.import') {
      return await deps.definitions.importDocument(parseWorkflowActionInput(WorkflowActionInputSchemasV1[actionId], rawArgs.input), context);
    }
    if (actionId === 'workflow.definition.export') {
      return await deps.definitions.exportDocument(parseWorkflowActionInput(WorkflowActionInputSchemasV1[actionId], rawArgs.input));
    }
    if (actionId === 'workflow.definition.create') {
      return await deps.definitions.create(parseWorkflowActionInput(WorkflowActionInputSchemasV1[actionId], rawArgs.input), context, rawArgs.context);
    }
    if (actionId === 'workflow.definition.update') {
      return await deps.definitions.update(parseWorkflowActionInput(WorkflowActionInputSchemasV1[actionId], rawArgs.input), context, rawArgs.context);
    }
    if (actionId === 'workflow.definition.edit') {
      return await deps.definitions.edit(parseWorkflowActionInput(WorkflowActionInputSchemasV1[actionId], rawArgs.input), context, rawArgs.context);
    }
    if (actionId === 'workflow.definition.delete') {
      return await deps.definitions.delete(parseWorkflowActionInput(WorkflowActionInputSchemasV1[actionId], rawArgs.input), rawArgs.context);
    }
    if (actionId === 'workflow.trigger.list') {
      return deps.triggers ? deps.triggers.list(parseWorkflowActionInput(WorkflowActionInputSchemasV1[actionId], rawArgs.input), rawArgs.context)
        : { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
    }
    if (actionId === 'workflow.trigger.run_now') {
      return deps.triggers ? deps.triggers.runNow(parseWorkflowActionInput(WorkflowActionInputSchemasV1[actionId], rawArgs.input), rawArgs.context)
        : { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
    }
    if (actionId === 'workflow.trigger.add') {
      return deps.triggers ? deps.triggers.add(parseWorkflowActionInput(WorkflowActionInputSchemasV1[actionId], rawArgs.input), rawArgs.context)
        : { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
    }
    if (actionId === 'workflow.trigger.update') {
      return deps.triggers ? deps.triggers.update(parseWorkflowActionInput(WorkflowActionInputSchemasV1[actionId], rawArgs.input), rawArgs.context)
        : { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
    }
    if (actionId === 'workflow.trigger.remove') {
      return deps.triggers ? deps.triggers.remove(parseWorkflowActionInput(WorkflowActionInputSchemasV1[actionId], rawArgs.input), rawArgs.context)
        : { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
    }
    if (actionId === 'session.trigger.list') {
      return deps.triggers ? deps.triggers.sessionList(parseWorkflowActionInput(WorkflowActionInputSchemasV1[actionId], rawArgs.input), rawArgs.context)
        : { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
    }
    if (actionId === 'session.trigger.add') {
      return deps.triggers ? deps.triggers.sessionAdd(parseWorkflowActionInput(WorkflowActionInputSchemasV1[actionId], rawArgs.input), rawArgs.context)
        : { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
    }
    if (actionId === 'session.trigger.update') {
      return deps.triggers ? deps.triggers.sessionUpdate(parseWorkflowActionInput(WorkflowActionInputSchemasV1[actionId], rawArgs.input), rawArgs.context)
        : { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
    }
    if (actionId === 'session.trigger.remove') {
      return deps.triggers ? deps.triggers.sessionRemove(parseWorkflowActionInput(WorkflowActionInputSchemasV1[actionId], rawArgs.input), rawArgs.context)
        : { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
    }
    if (!isWorkflowRunActionArgs(rawArgs)) {
      return { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
    }
    switch (rawArgs.actionId) {
      case 'workflow.run.start':
      case 'workflow.run.list':
      case 'workflow.run.summaries':
      case 'workflow.run.get':
      case 'workflow.run.wait':
      case 'workflow.run.pause':
      case 'workflow.run.resume':
      case 'workflow.run.cancel':
      case 'workflow.run.invocations.list':
      case 'workflow.run.invocations.get':
      case 'workflow.run.invocations.retry':
      case 'workflow.run.invocations.publish_draft':
      case 'workflow.run.invocations.complete_review':
      case 'workflow.run.delete':
        parseWorkflowActionInput<unknown>(WorkflowActionInputSchemasV1[rawArgs.actionId], rawArgs.input);
        return await deps.runs.execute(rawArgs, context);
      default:
        rawArgs satisfies never;
        throw new Error('unreachable_workflow_run_action');
    }
  };
  return async (args) => {
    const startedAtMs = Date.now();
    try {
      return await execute(args);
    } catch (error) {
      return normalizeWorkflowActionThrownError(error, deps.onFailureDiagnostic ? {
        operation: args.actionId, durationMs: Date.now() - startedAtMs, emit: deps.onFailureDiagnostic,
      } : undefined);
    }
  };
}
