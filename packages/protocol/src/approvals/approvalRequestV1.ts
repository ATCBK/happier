import * as zMini from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";

import { ActionApprovalSchema, resolveActionApprovalFlow } from '../actions/actionApprovalMetadata.js';
import { ActionIdSchema } from '../actions/actionIds.js';
import { PluginContributionLocalIdSchema } from '../plugins/contributionIdentity.js';
import { PluginIdSchema } from '../plugins/pluginId.js';
import {
  SessionCreationDirectoryApprovalV1Schema,
} from '../sessions/creation/sessionCreationTargetPreparationV1.js';
import { HandoffTargetReplacementApprovalV1Schema } from '../sessions/control/handoff/handoffTargetReplacementApprovalV1.js';
import { ActionRequiredAuthoritySchema } from '../actions/metadata.js';
import { isAutomationApprovalRequestSurface } from '../actions/decisionAuthority.js';
import { getActionSpec, resolveActionExecutionPlacementForInput } from '../actions/actionSpecs.js';
import {
  ExternalActionTargetV1Schema,
  ExternalActionExecutionAuthorizationV1Schema,
  isExternalActionResolvedTargetAllowedV1,
} from '../actions/externalActionApi.js';
import { AutomationRunCauseSchema } from '../automations/automationRunCause.js';
import { AgentPermissionIntentV1Schema } from '../runtime/permissionIntentV1.js';
import { SessionAgentSpawnPolicyV1StrictSchema } from '../account/settings/sessionAgentSpawnPolicyV1.js';
import {
  SessionInputCausalPermissionAuthorityV1Schema,
  SessionInputSourceSessionV1Schema,
} from '../sessions/messages/sessionInputAdmission.js';
import { PluginSourceCustodyV1Schema } from '../plugins/runtime/sourceCustody.js';
import { WorkflowAcceptedAuthorizationV1Schema, WorkflowRunStartedByV1Schema } from '../workflows/workflowDefinitionV1.js';
import { AgentStartSessionCallerV1Schema } from '../account/settings/admitAgentStartV1.js';
import { ComputerSecretFillRequestV1Schema, SecretFillSettlementV1Schema } from '../computer/v1.js';
import { BrowserAutomationSecretFillRequestV1Schema } from '../browser/automation/v1.js';
import { sameStrictJsonValue, StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { MachineStorageTrashMoveInputV1Schema, PileApplyResultStoredV1Schema, PileApplyResultV1Schema } from '../storage/storageV1.js';
import { ApprovalStaleFailureDetailsSchema } from './approvalStaleReason.js';
export { ApprovalStaleReasonSchema, ApprovalStaleFailureDetailsSchema, type ApprovalStaleReason } from './approvalStaleReason.js';

export const ApprovalRequestStatusSchema = lazyZodSchema(() => z.enum(['open', 'approved', 'rejected', 'executed', 'failed', 'canceled']));
export type ApprovalRequestStatus = z.infer<typeof ApprovalRequestStatusSchema>;

/** Current executable lifecycle. The released V1 status schema above stays byte-for-byte closed. */
export const ApprovalRequestV2StatusSchema = lazyZodSchema(() => z.enum([
  'open', 'approved', 'executing', 'rejected', 'executed', 'failed', 'canceled',
]));

const ApprovalRequestedSurfaceSchema = lazyZodSchema(() => z.string().check(z.minLength(1)));

/**
 * Released ApprovalRequestV1 artifacts may name this retired interactive
 * picker. It remains history-only: current Action catalog and V2 replay use
 * ActionIdSchema directly.
 */
const ApprovalRequestV1HistoricalActionIdSchema = lazyZodSchema(() => z.union([
  ActionIdSchema,
  z.literal('session.spawn_picker'),
]));

export const ApprovalRequestOriginV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('transcript_tool_call'),
  sessionId: z.string().check(z.minLength(1)),
  messageId: z.optional(z.string().check(z.minLength(1))),
  parentMessageId: z.optional(z.string().check(z.minLength(1))),
  toolCallId: z.optional(z.string().check(z.minLength(1))),
  mcpRequestId: z.optional(z.string().check(z.minLength(1))),
  toolName: z.optional(z.string().check(z.minLength(1))),
  toolInput: z.optional(z.unknown()),
}).check(z.superRefine((value, ctx) => {
  if (value.messageId || value.parentMessageId || value.toolCallId || value.toolName) {
    return;
  }
  ctx.addIssue({
    code: "custom",
    path: ['origin'],
    message: 'transcript tool-call approval origins require a messageId, parentMessageId, toolCallId, or toolName',
  });
})));
export type ApprovalRequestOriginV1 = z.infer<typeof ApprovalRequestOriginV1Schema>;

export const ApprovalRequestCreatedBySchema = lazyZodSchema(() => z.strictObject({
  surface: z.enum(['voice', 'agent', 'session_agent', 'mcp', 'cli', 'system']),
  agentId: z.optional(z.string().check(z.minLength(1))),
  pluginId: zMini.optional(asProtocolZod(PluginIdSchema)),
  contributionLocalId: zMini.optional(asProtocolZod(PluginContributionLocalIdSchema)),
  sessionId: z.optional(z.string().check(z.minLength(1))),
}));
export type ApprovalRequestCreatedBy = z.infer<typeof ApprovalRequestCreatedBySchema>;

export const ApprovalDecisionV1Schema = lazyZodSchema(() => z.looseObject({
  kind: z.enum(['approve', 'reject']),
  decidedAtMs: z.number().check(z.int(), z.minimum(0)),
}));
export type ApprovalDecisionV1 = z.infer<typeof ApprovalDecisionV1Schema>;

// Current decision authority is host-stamped. Released V1 history retains its
// original passthrough schema and never authorizes current operand edits.
const ApprovalDecisionV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ApprovalDecisionV1Schema, {
  authority: z.optional(z.literal('present_user')),
  narrowedInput: zMini.optional(StrictJsonValueSchema),
})));

export const ApprovalExecutionV1Schema = lazyZodSchema(() => z.looseObject({
  executedAtMs: z.number().check(z.int(), z.minimum(0)),
  ok: z.boolean(),
  result: z.optional(z.unknown()),
  errorCode: z.optional(z.string().check(z.minLength(1))),
  error: z.optional(z.string().check(z.minLength(1))),
}));
export type ApprovalExecutionV1 = z.infer<typeof ApprovalExecutionV1Schema>;

/**
 * Current execution history. Failure details are admitted only by the
 * request-bound validator below; this field is not an arbitrary error bag.
 */
export const ApprovalExecutionV2Schema = lazyZodSchema(() => z.strictObject({
  executedAtMs: z.number().check(z.int(), z.minimum(0)),
  /** False only when the approval settled before its Action effect was invoked. */
  effectAttempted: z.optional(z.boolean()),
  ok: z.boolean(),
  result: z.optional(z.unknown()),
  errorCode: z.optional(z.string().check(z.minLength(1))),
  error: z.optional(z.string().check(z.minLength(1))),
  details: z.optional(z.unknown()),
}));
export type ApprovalExecutionV2 = z.infer<typeof ApprovalExecutionV2Schema>;

const ApprovalExecutionOriginSurfaceV1Schema = lazyZodSchema(() => z.enum([
  'ui',
  'voice',
  'agent',
  'mcp',
  'cli',
  'rpc',
  'api',
  'plugin',
]));

export const ApprovalExecutionOriginCallerV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('host') }),
  AgentStartSessionCallerV1Schema,
  z.strictObject({
    kind: z.literal('plugin'),
    pluginId: asProtocolZod(PluginIdSchema),
    contributionLocalId: asProtocolZod(PluginContributionLocalIdSchema),
    sourceCustody: PluginSourceCustodyV1Schema,
    /** Bounded descriptive admission fact for durable replay, never recursive authority. */
    startedBy: zMini.optional(WorkflowRunStartedByV1Schema),
  }),
  z.strictObject({
    kind: z.literal('automationRun'),
    runId: z.string().check(z.trim(), z.minLength(1)),
    automationId: z.string().check(z.trim(), z.minLength(1)),
    cause: AutomationRunCauseSchema,
  }),
  /**
   * Host-stamped provenance for an admitted Workflow Run, carrying the exact
   * accepted authorization the live Workflow admission already owns. Replay
   * currentness rechecks that principal; the Run identity is immutable.
   */
  z.strictObject({
    kind: z.literal('workflowRun'),
    runId: z.string().check(z.trim(), z.minLength(1)),
    authorization: WorkflowAcceptedAuthorizationV1Schema,
  }),
]));
export type ApprovalExecutionOriginCallerV1 = z.infer<typeof ApprovalExecutionOriginCallerV1Schema>;

/**
 * Immutable authority and routing facts captured when a durable approval is
 * admitted. External invocation authorization is Machine-bound authorization
 * material; it contains no PAT bearer and cannot authenticate without that
 * Machine's signature. Descriptive `createdBy`/`origin` is display metadata.
 */
export const ApprovalExecutionOriginV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  authority: ActionRequiredAuthoritySchema,
  surface: ApprovalExecutionOriginSurfaceV1Schema,
  caller: ApprovalExecutionOriginCallerV1Schema,
  /** Local profile identifier used to route the replay to its configured Home. */
  serverId: z.string().check(z.trim(), z.minLength(1)),
  /** Cryptographic Home identity, required for a Home-signed external invocation. */
  serverIdentityId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  accountId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  principalId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  credentialId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  externalActionExecutionAuthorization: zMini.optional(ExternalActionExecutionAuthorizationV1Schema),
  externalActionInputSignature: z.optional(z.string().check(z.regex(/^[A-Za-z0-9_-]{86}$/u))),
  sessionId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  /** Original host corpus binding; current resource admission remains mandatory. */
  sessionListAccess: z.optional(z.enum(['current_session', 'led_subtree', 'unavailable'])),
  machineId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  runId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  runOccurrenceId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  /** Original admitted permission inputs; current runtime policy is rechecked before replay. */
  callerPermissionMode: zMini.optional(zMini.nullable(asProtocolZod(AgentPermissionIntentV1Schema))),
  sessionAgentSpawnPolicyV1: zMini.optional(SessionAgentSpawnPolicyV1StrictSchema),
  causalPermissionAuthority: zMini.optional(zMini.nullable(SessionInputCausalPermissionAuthorityV1Schema)),
  sessionInputSource: zMini.optional(zMini.nullable(SessionInputSourceSessionV1Schema)),
  target: zMini.optional(ExternalActionTargetV1Schema),
  actionId: ActionIdSchema,
  requestId: z.string().check(z.trim(), z.minLength(1)),
}).check(z.superRefine((value, ctx) => {
  if ((value.sessionListAccess === 'current_session' || value.sessionListAccess === 'led_subtree') && !value.sessionId) {
    ctx.addIssue({ code: "custom", path: ['sessionListAccess'],
      message: 'Current-Session list scope requires an exact Session binding' });
  }
  if (
    value.actionId === 'session.list'
    && (value.surface === 'agent' || value.surface === 'mcp' || value.surface === 'plugin')
    && value.sessionListAccess !== 'current_session'
    && value.sessionListAccess !== 'led_subtree'
  ) {
    ctx.addIssue({
      code: "custom",
      path: ['sessionListAccess'],
      message: 'Autonomous Session-list approval origins require their exact admitted Session corpus',
    });
  }
  const authorization = value.externalActionExecutionAuthorization;
  if (authorization) {
    const binding = authorization.binding;
    const admittedTarget = value.target !== undefined
      && isExternalActionResolvedTargetAllowedV1({
        authorizedTarget: binding.target,
        resolvedTarget: value.target,
        selectedMachineId: binding.machineId,
      });
    const principalMatches = 'authentication' in binding
      ? value.principalId === undefined && value.credentialId === undefined
        && (binding.sessionActionOrigin
          ? value.surface === 'agent' && value.authority === 'account_automation'
            && sameStrictJsonValue(value.caller, binding.sessionActionOrigin.caller)
            && value.callerPermissionMode === binding.sessionActionOrigin.callerPermissionMode
            && sameStrictJsonValue(value.causalPermissionAuthority ?? null, binding.sessionActionOrigin.causalPermissionAuthority ?? null)
            && value.sessionInputSource?.sourceSessionId === binding.sessionActionOrigin.caller.sessionId
            && value.sessionInputSource.sourceTurnId === binding.sessionActionOrigin.sourceTurnId
            && value.sessionInputSource.via === 'action'
          : ((value.surface === 'ui' || value.surface === 'cli') && value.caller.kind === 'host'
              || value.surface === 'plugin' && value.caller.kind === 'plugin')
            && (value.authority === 'present_user'
              // A Home-admitted paired terminal can propose an approval while
              // retaining automation authority; only the decision grants consent.
              || value.authority === 'account_automation'))
      : value.surface === 'api' && value.authority === 'account_automation'
        && value.principalId === binding.principalId && value.credentialId === binding.credentialId;
    if (!principalMatches || value.serverIdentityId !== binding.serverIdentityId
      || value.accountId !== binding.accountId
      || value.requestId !== binding.requestId || value.machineId !== binding.machineId || !admittedTarget) {
      ctx.addIssue({ code: "custom", path: ['externalActionExecutionAuthorization'],
        message: 'Execution authorization must match the exact originating invocation' });
    }
  }
  const credentialFieldCount = [value.principalId, value.credentialId]
    .filter((field) => field !== undefined).length;
  if (credentialFieldCount === 1 || (credentialFieldCount === 2 && !value.accountId)) {
    ctx.addIssue({
      code: "custom",
      path: ['credentialId'],
      message: 'external approval origins require accountId, principalId, and credentialId together',
    });
  }
  if (value.surface === 'api' && (!value.accountId || credentialFieldCount !== 2)) {
    ctx.addIssue({
      code: "custom",
      path: ['credentialId'],
      message: 'API approval origins require verified credential provenance',
    });
  }
  if (value.target?.kind === 'session' && value.sessionId !== value.target.sessionId) {
    ctx.addIssue({
      code: "custom",
      path: ['sessionId'],
      message: 'Session-target approval origins require the same exact Session id',
    });
  }
  if (value.target?.kind === 'machine' && value.machineId !== value.target.machineId) {
    ctx.addIssue({
      code: "custom",
      path: ['machineId'],
      message: 'Machine-target approval origins require the same exact machine id',
    });
  }
  if (value.caller.kind === 'automationRun' && value.runId !== value.caller.runId) {
    ctx.addIssue({
      code: "custom",
      path: ['runId'],
      message: 'Automation-run approval origins require the same exact Run id',
    });
  }
})));
export type ApprovalExecutionOriginV1 = z.infer<typeof ApprovalExecutionOriginV1Schema>;

function validateApprovalRequestLifecycle(
  value: Readonly<Record<string, unknown>>,
  ctx: z.core.$RefinementCtx,
): void {
  const status = value.status as z.infer<typeof ApprovalRequestV2StatusSchema>;
  const decision = value.decision as ApprovalDecisionV1 | undefined;
  const execution = value.execution as ApprovalExecutionV1 | undefined;
  const requiresDecision = status === 'approved'
    || status === 'executing'
    || status === 'rejected'
    || status === 'executed'
    || status === 'failed';
  const requiresExecution = status === 'executed' || status === 'failed';

  if (status === 'open') {
    if (decision != null) ctx.addIssue({ code: "custom", path: ['decision'], message: 'open approval requests must not include a decision' });
    if (execution != null) ctx.addIssue({ code: "custom", path: ['execution'], message: 'open approval requests must not include execution metadata' });
  }
  if (requiresDecision && decision == null) ctx.addIssue({ code: "custom", path: ['decision'], message: `status ${status} requires a decision` });
  if (requiresExecution && execution == null) ctx.addIssue({ code: "custom", path: ['execution'], message: `status ${status} requires execution metadata` });
  if (!requiresExecution && execution != null) ctx.addIssue({ code: "custom", path: ['execution'], message: `status ${status} must not include execution metadata` });
  if ((status === 'approved' || status === 'executing' || status === 'executed' || status === 'failed') && decision?.kind !== 'approve') {
    ctx.addIssue({ code: "custom", path: ['decision'], message: `status ${status} requires an approve decision` });
  }
  if (status === 'rejected' && decision?.kind !== 'reject') ctx.addIssue({ code: "custom", path: ['decision'], message: 'status rejected requires a reject decision' });
  if (status === 'canceled' && decision != null) ctx.addIssue({ code: "custom", path: ['decision'], message: 'canceled approval requests must not include a decision' });
  if (status === 'executed' && execution?.ok !== true) ctx.addIssue({ code: "custom", path: ['execution'], message: 'status executed requires a successful execution result' });
  if (status === 'failed' && execution?.ok !== false) ctx.addIssue({ code: "custom", path: ['execution'], message: 'status failed requires a failed execution result' });
  if (value.v === 2 && execution?.ok === true && Object.hasOwn(execution, 'details')) {
    ctx.addIssue({ code: "custom", path: ['execution', 'details'], message: 'successful approval execution cannot include failure details' });
  }

  if (value.sessionCreationDirectoryApproval !== undefined && value.actionId !== 'session.spawn_new') {
    ctx.addIssue({ code: "custom", path: ['sessionCreationDirectoryApproval'], message: 'Directory creation approval evidence belongs only to session.spawn_new.' });
  }
  if (value.handoffTargetReplacementApproval !== undefined
    && value.actionId !== 'session.handoff'
    && !(value.v === 2 && value.actionId === 'workspace.sync.relationship.create')) {
    ctx.addIssue({ code: "custom", path: ['handoffTargetReplacementApproval'], message: 'Workspace target approval evidence belongs only to destination-choosing Actions.' });
  }
  validateConfidentialApprovalRequest(value, ctx);
}

/** Read-only retry receipts belong to the original failed items, never to replay authority. */
function validateStorageRetryResults(value: Readonly<Record<string, unknown>>, ctx: z.core.$RefinementCtx): void {
  if (value.storageRetryResults === undefined) return;
  const issue = () => ctx.addIssue({ code: "custom", path: ['storageRetryResults'],
    message: 'Storage retry receipts require distinct settled batches for the proposal’s unsuccessful items' });
  const original = PileApplyResultStoredV1Schema.safeParse((value.execution as ApprovalExecutionV2 | undefined)?.result);
  const args = MachineStorageTrashMoveInputV1Schema.safeParse(value.actionArgs);
  const retries = z.array(PileApplyResultV1Schema).check(z.minLength(1)).safeParse(value.storageRetryResults);
  if (value.v !== 2 || value.status !== 'executed' || value.actionId !== 'machines.storage.trash.move'
    || !original.success || !args.success || !retries.success) { issue(); return; }
  const requested = new Set(args.data.items.map(item => item.ref.itemId));
  const unsuccessful = new Set(original.data.outcomes.filter(outcome => requested.has(outcome.itemId)
    && outcome.status !== 'moved' && outcome.status !== 'deleted').map(outcome => outcome.itemId));
  const batches = new Set([original.data.batchId]);
  const entries = new Set(original.data.trashEntryIds ?? []);
  for (const retry of retries.data) {
    const items = new Set<string>();
    if (retry.mode !== 'trash' || batches.has(retry.batchId) || retry.trashEntryIds === undefined
      || retry.outcomes.length === 0 || retry.trashEntryIds.length > retry.outcomes.filter(outcome => outcome.status === 'moved').length) {
      issue(); return;
    }
    batches.add(retry.batchId);
    for (const outcome of retry.outcomes) {
      if (!unsuccessful.has(outcome.itemId) || items.has(outcome.itemId)) { issue(); return; }
      items.add(outcome.itemId);
      if (outcome.status === 'moved' || outcome.status === 'deleted') unsuccessful.delete(outcome.itemId);
    }
    for (const entryId of retry.trashEntryIds) {
      if (entries.has(entryId)) { issue(); return; }
      entries.add(entryId);
    }
  }
}

const ConfidentialApprovalFailureCodeSchema = lazyZodSchema(() => z.enum([
  'approval_stale', 'approval_context_unavailable', 'approval_execution_outcome_unknown',
  'confidential_choice_required', 'unsupported_action', 'invalid_parameters', 'present_user_required',
  'approval_not_found', 'approval_invalid', 'approval_not_open', 'action_disabled', 'credential_scope_denied',
]));

/** The durable request never becomes a carrier for the live human credential choice or native echoes. */
function validateConfidentialApprovalRequest(value: Readonly<Record<string, unknown>>, ctx: z.core.$RefinementCtx): void {
  const actionId = value.actionId;
  if (actionId !== 'computer.secret.fill' && actionId !== 'browser.automation.secret.fill') return;
  const issue = (path: (string | number)[]) => ctx.addIssue({
    code: "custom", path, message: 'Confidential approval requires exact value-free custody',
  });
  if (value.v !== 2) { issue(['v']); return; }
  const inputSchema = actionId === 'computer.secret.fill'
    ? ComputerSecretFillRequestV1Schema : BrowserAutomationSecretFillRequestV1Schema;
  const args = inputSchema.safeParse(value.actionArgs);
  if (!args.success) issue(['actionArgs']);
  const origin = ApprovalExecutionOriginV1Schema.safeParse(value.executionOriginV1);
  if (args.success && origin.success) {
    for (const field of ['serverId', 'sessionId', 'machineId'] as const) {
      if (args.data[field] !== origin.data[field]) issue(['actionArgs', field]);
    }
  }
  if (value.preview !== undefined) {
    const preview = z.strictObject({ actionId: z.literal(actionId), actionArgs: inputSchema }).safeParse(value.preview);
    if (!preview.success || !args.success || !sameStrictJsonValue(preview.data.actionArgs, args.data)) issue(['preview']);
  }
  const transcriptOrigin = ApprovalRequestOriginV1Schema.safeParse(value.origin);
  if (transcriptOrigin.success && transcriptOrigin.data.toolInput !== undefined) {
    const toolInput = transcriptOrigin.data.toolInput;
    const direct = inputSchema.safeParse(toolInput);
    const wrapped = z.strictObject({ actionId: z.literal(actionId), input: inputSchema }).safeParse(toolInput);
    const parsedInput = direct.success ? direct.data : wrapped.success ? wrapped.data.input : undefined;
    if (!args.success || parsedInput === undefined || !sameStrictJsonValue(parsedInput, args.data)) issue(['origin', 'toolInput']);
  }
  const execution = ApprovalExecutionV2Schema.safeParse(value.execution);
  if (execution.success) {
    const record = execution.data;
    if (record.result !== undefined && !SecretFillSettlementV1Schema.safeParse(record.result).success) issue(['execution', 'result']);
    if (record.ok && record.result === undefined) issue(['execution', 'result']);
    if (record.details !== undefined && (record.ok || record.errorCode !== 'approval_stale'
      || !ApprovalStaleFailureDetailsSchema.safeParse(record.details).success)) issue(['execution', 'details']);
    if (!record.ok && (!ConfidentialApprovalFailureCodeSchema.safeParse(record.errorCode).success || record.error !== record.errorCode)) issue(['execution', 'error']);
    if (record.ok && (record.error !== undefined || record.errorCode !== undefined)) issue(['execution', 'error']);
  }
}

export const ApprovalRequestV1Schema = lazyZodSchema(() => z.looseObject({
  v: z.literal(1),
  status: ApprovalRequestStatusSchema,
  createdAtMs: z.number().check(z.int(), z.minimum(0)),
  updatedAtMs: z.number().check(z.int(), z.minimum(0)),
  createdBy: ApprovalRequestCreatedBySchema,
  requestedSurface: z.optional(ApprovalRequestedSurfaceSchema),
  origin: z.optional(ApprovalRequestOriginV1Schema),
  approval: zMini.optional(ActionApprovalSchema),
  actionId: ApprovalRequestV1HistoricalActionIdSchema,
  actionArgs: z.unknown(),
  summary: z.string().check(z.minLength(1)),
  preview: z.optional(z.unknown()),
  /**
   * Host-stamped target evidence for a deferred `session.spawn_new` directory
   * creation approval. It is not Action input and cannot authorize another
   * Action family.
   */
  sessionCreationDirectoryApproval: zMini.optional(SessionCreationDirectoryApprovalV1Schema),
  /** Host-stamped workspace destination evidence; never Action input. */
  handoffTargetReplacementApproval: zMini.optional(HandoffTargetReplacementApprovalV1Schema),
  decision: z.optional(ApprovalDecisionV1Schema),
  execution: z.optional(ApprovalExecutionV1Schema),
}).check(z.superRefine((value, ctx) => {
  validateApprovalRequestLifecycle(value, ctx);
})));
export type ApprovalRequestV1 = z.infer<typeof ApprovalRequestV1Schema>;

/** Current durable replay format. V1 remains readable history but carries no replay authority. */
export const ApprovalRequestV2Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(2),
  status: ApprovalRequestV2StatusSchema,
  createdAtMs: z.number().check(z.int(), z.minimum(0)),
  updatedAtMs: z.number().check(z.int(), z.minimum(0)),
  createdBy: ApprovalRequestCreatedBySchema,
  requestedSurface: z.optional(ApprovalRequestedSurfaceSchema),
  origin: z.optional(ApprovalRequestOriginV1Schema),
  executionOriginV1: ApprovalExecutionOriginV1Schema,
  approval: zMini.optional(ActionApprovalSchema),
  actionId: ActionIdSchema,
  actionArgs: z.unknown(),
  summary: z.string().check(z.minLength(1)),
  preview: z.optional(z.unknown()),
  sessionCreationDirectoryApproval: zMini.optional(SessionCreationDirectoryApprovalV1Schema),
  handoffTargetReplacementApproval: zMini.optional(HandoffTargetReplacementApprovalV1Schema),
  decision: z.optional(ApprovalDecisionV2Schema),
  execution: z.optional(ApprovalExecutionV2Schema),
  /** Settled results of new UI retries; original execution and approval authority stay immutable. */
  storageRetryResults: z.optional(z.array(PileApplyResultV1Schema).check(z.minLength(1))),
}).check(z.superRefine((value, ctx) => {
  validateApprovalRequestLifecycle(value, ctx);
  validateStorageRetryResults(value, ctx);
  if (value.executionOriginV1.actionId !== value.actionId) {
    ctx.addIssue({ code: "custom", path: ['executionOriginV1', 'actionId'], message: 'execution origin Action must match the approved Action' });
  }
  // A Home-signed external invocation is persisted as an `api` origin even when
  // the caller reached it through another surface, so the descriptive requested
  // surface records that nested caller without contradicting the authority. Any
  // other surface pair repeats one fact twice and must agree exactly.
  const nestedExternalInvocation = value.executionOriginV1.surface === 'api'
    && value.executionOriginV1.externalActionExecutionAuthorization !== undefined;
  if (
    value.requestedSurface !== undefined
    && value.requestedSurface !== value.executionOriginV1.surface
    && !nestedExternalInvocation
  ) {
    ctx.addIssue({ code: "custom", path: ['requestedSurface'], message: 'requested surface must match the immutable execution origin' });
  }
  const originCaller = value.executionOriginV1.caller;
  if (originCaller.kind === 'plugin') {
    if (value.createdBy.pluginId !== undefined && value.createdBy.pluginId !== originCaller.pluginId) {
      ctx.addIssue({ code: "custom", path: ['createdBy', 'pluginId'], message: 'display plugin must match the immutable execution origin' });
    }
    if (
      value.createdBy.contributionLocalId !== undefined
      && value.createdBy.contributionLocalId !== originCaller.contributionLocalId
    ) {
      ctx.addIssue({ code: "custom", path: ['createdBy', 'contributionLocalId'], message: 'display contribution must match the immutable execution origin' });
    }
  } else if (value.createdBy.pluginId !== undefined || value.createdBy.contributionLocalId !== undefined) {
    ctx.addIssue({ code: "custom", path: ['createdBy'], message: 'display plugin identity requires a plugin execution origin' });
  }
})));
export type ApprovalRequestV2 = z.infer<typeof ApprovalRequestV2Schema>;

export const ApprovalRequestSchema = lazyZodSchema(() => z.discriminatedUnion('v', [
  ApprovalRequestV1Schema,
  ApprovalRequestV2Schema,
]));
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
export const StoredApprovalRequestSchema = createStoredReadSchema(ApprovalRequestSchema);

/**
 * Caller principals whose currentness only the exact daemon that admitted them
 * can recheck (plugin source custody, Automation Run currentness, Workflow
 * accepted authorization). Declared beside the caller union it keys on, so a new
 * arm cannot be added without answering this question — the hand-maintained
 * consumer-side list it replaced silently defaulted new arms to local replay.
 */
const CALLER_REQUIRES_EXACT_DAEMON_REPLAY_RECORD = {
  host: false,
  session: true,
  plugin: true,
  automationRun: true,
  workflowRun: true,
} as const satisfies Record<ApprovalExecutionOriginCallerV1['kind'], boolean>;

/**
 * Surfaces whose admission facts (external authorization, agent ceilings,
 * transport identity) the exact daemon owns, except for the host Account effects
 * admitted by the shared custody predicate below.
 */
const SURFACE_REQUIRES_EXACT_DAEMON_REPLAY_RECORD = {
  ui: false,
  voice: false,
  plugin: false,
  agent: true,
  mcp: true,
  cli: true,
  rpc: true,
  api: true,
} as const satisfies Record<ApprovalExecutionOriginV1['surface'], boolean>;

function resolveApprovalRequestAppExecutionPlacement(approval: ApprovalRequest): 'account' | 'client' | null {
  const actionId = ActionIdSchema.safeParse(approval.actionId);
  const spec = actionId.success ? getActionSpec(actionId.data) : null;
  const input = spec?.inputSchema.safeParse(approval.actionArgs);
  // The admitted request owns its flow; authored specs may omit the default
  // or be routed as deferred proposals. A blocking show-once result belongs
  // to the original invocation, never the approving app or durable history.
  const retainedLiveResult = spec?.approvalResultCustody === 'live_only'
    && resolveActionApprovalFlow(approval.approval ?? spec.approval) === 'blocking';
  if (!spec || !input?.success || spec.workspaceWrite === true
    || spec.approvalInputCustody === 'live_only' || retainedLiveResult) return null;
  const placement = resolveActionExecutionPlacementForInput(spec, input.data);
  return placement === 'account' || placement === 'client' ? placement : null;
}

/** Eligibility only: the host must still prove current source custody and own the live waiter. */
export function isMountedPluginBlockingApprovalEligibleForLiveClient(approval: ApprovalRequest): boolean {
  if (approval.v !== 2 || !approval.approval || resolveActionApprovalFlow(approval.approval) !== 'blocking'
    || resolveApprovalRequestAppExecutionPlacement(approval) === null) return false;
  const origin = approval.executionOriginV1;
  return origin.surface === 'plugin' && origin.authority === 'account_automation'
    && origin.caller.kind === 'plugin' && Boolean(origin.serverIdentityId && origin.accountId && origin.machineId)
    && origin.externalActionExecutionAuthorization === undefined && origin.externalActionInputSignature === undefined
    && origin.principalId === undefined && origin.credentialId === undefined
    && origin.sessionId === undefined && origin.sessionListAccess === undefined && origin.sessionInputSource === undefined
    && origin.runId === undefined && origin.runOccurrenceId === undefined && origin.callerPermissionMode === undefined
    && origin.causalPermissionAuthority === undefined && origin.sessionAgentSpawnPolicyV1 === undefined
    && (origin.target === undefined || origin.target.kind === 'machine' && origin.target.machineId === origin.machineId);
}

/**
 * True when this durable approval carries authority facts a client cannot
 * verify itself, so its replay belongs to the exact daemon named by the origin.
 * Unsigned host-caused Account/client approvals on a present-user surface remain
 * locally replayable, as do durable host-origin Account effects and,
 * by the 2026-10-12 owner ruling, signed Agent-Session proposals whose reviewed
 * effect is Account/client-only: the approving app runs that effect while the signed
 * carrier stays immutable proposal provenance. Other signed external origins
 * retain their admitting daemon's custody.
 */
export function requiresExactDaemonApprovalReplay(approval: ApprovalRequest): boolean {
  if (approval.v !== 2) return false;
  const origin = approval.executionOriginV1;
  const actionId = ActionIdSchema.safeParse(approval.actionId);
  const spec = actionId.success ? getActionSpec(actionId.data) : null;
  const input = spec?.inputSchema.safeParse(approval.actionArgs);
  const appPlacement = resolveApprovalRequestAppExecutionPlacement(approval);
  const clientEffect = appPlacement === 'client';
  const accountEffect = appPlacement === 'account';
  const authorization = origin.externalActionExecutionAuthorization;
  if (authorization) {
    return !((accountEffect || clientEffect) && 'authentication' in authorization.binding
      && authorization.binding.sessionActionOrigin !== undefined);
  }
  // Client effects belong to the approving app's mounted owner. The requesting
  // Session's Machine is provenance, not the location of its microphone or UI.
  // Plugin/Run custody and CLI/API transport authority still stay exact.
  if (clientEffect && (origin.caller.kind === 'host' || origin.caller.kind === 'session')
    && (origin.surface === 'ui' || origin.surface === 'voice' || origin.surface === 'agent' || origin.surface === 'mcp')) return false;
  // Replaying a Machine effect in the app would issue a fresh external root
  // and ask again. Its exact daemon consumes the recorded decision instead.
  if (origin.surface === 'ui' && origin.caller.kind === 'host'
    && spec && input?.success && resolveActionExecutionPlacementForInput(spec, input.data) === 'machine') return true;
  // These Account effects run through the deciding app's authenticated Home
  // adapter, so a daemon's disallowed terminal policy cannot veto human consent.
  // Plugin and other external provenance still belongs to its original executor.
  if (spec && origin.caller.kind === 'host'
    && spec.approvalInputCustody !== 'live_only') {
    if (accountEffect && (origin.surface === 'cli'
      || isAutomationApprovalRequestSurface(origin.surface, spec, approval.actionArgs))) return false;
  }
  return SURFACE_REQUIRES_EXACT_DAEMON_REPLAY_RECORD[origin.surface]
    || CALLER_REQUIRES_EXACT_DAEMON_REPLAY_RECORD[origin.caller.kind];
}
