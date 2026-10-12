import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { WorkflowRunIdV1Schema } from '../workflows/workflowIdsV1.js';
import { ProviderAccountUsageRecordIdSchema } from '../connect/providerAccountUsagePrimitives.js';
import { ProviderAccountUsagePaceWindowV1Schema } from '../connect/deriveProviderAccountUsagePace.js';
import { UsageQuotaNotificationKindV1Schema } from '../account/settings/usagePacingPreferencesV1.js';
import { MachineVitalsDiskThresholdV1Schema } from '../machines/vitals/machineVitalsAlertsV1.js';
import { SessionGuardStateV1Schema } from '../machines/guard/sessionGuardStateV1.js';
import { TerminalGuardStateV1Schema } from '../machines/guard/terminalGuardStateV1.js';
import { PUSH_NOTIFICATION_CATEGORY_IDS } from '../push/pushNotificationActions.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { getActionSpec } from '../actions/actionSpecs.js';
import { MACHINE_TERMINAL_ACTION_INPUT_SCHEMAS } from '../actions/specs/machineTerminal.js';

const UsageResetNotificationEvidenceV1Schema = lazyZodSchema(() => ProviderAccountUsagePaceWindowV1Schema.extend({
  observedAtMs: z.number().int().nonnegative(), previousObservedAtMs: z.number().int().nonnegative(),
  witnessedAtMs: z.number().int().nonnegative().optional(),
}).strict());
const UsageWindowNotificationEvidenceV1Schema = lazyZodSchema(() => UsageResetNotificationEvidenceV1Schema.extend({
  usedFraction: z.number().finite().nonnegative(), elapsedFraction: z.number().finite().positive().max(1),
  pace: z.number().finite().nonnegative(), projectedResetUtilizationFraction: z.number().finite().nonnegative(),
  qualification: z.enum(['confirmed', 'estimated']), sampleCount: z.number().int().positive(),
}).strict());
const UsageCreditNotificationEvidenceV1Schema = lazyZodSchema(() => z.object({
  recordId: ProviderAccountUsageRecordIdSchema, creditId: z.string().min(1), expiresAtMs: z.number().int().nonnegative(),
  observedAtMs: z.number().int().nonnegative(), previousObservedAtMs: z.number().int().nonnegative(),
}).strict());
export const ConnectedServiceUsageNotificationV1Schema = lazyZodSchema(() => z.object({
  topic: z.literal('connected_service_usage'), kind: UsageQuotaNotificationKindV1Schema,
  serviceId: z.string().min(1), profileId: z.string().min(1), issueFingerprint: z.string().min(1),
  evidence: z.union([UsageWindowNotificationEvidenceV1Schema, UsageResetNotificationEvidenceV1Schema, UsageCreditNotificationEvidenceV1Schema]),
}).strict().superRefine((event, ctx) => {
  if ((event.kind === 'credit_expiry') !== ('creditId' in event.evidence)
    || (event.kind !== 'reset' && !('creditId' in event.evidence) && !('pace' in event.evidence))) {
    ctx.addIssue({ code: 'custom', path: ['evidence'], message: 'Evidence must match notification kind' });
  }
}));
export type ConnectedServiceUsageNotificationV1 = z.infer<typeof ConnectedServiceUsageNotificationV1Schema>;

/** Closed V1 evidence envelope; no process identities or private Session labels. */
export const MachineVitalsNotificationV1Schema = lazyZodSchema(() => {
  const common = {
    topic: z.literal('resource_limit'), phase: z.enum(['started', 'recovered']),
    machineId: z.string().min(1), machineName: z.string().min(1).optional(),
    at: z.number().finite().nonnegative(), since: z.number().finite().nonnegative(),
    workingSessionCount: z.number().int().nonnegative().optional(), guardEnabled: z.boolean(),
  };
  return z.discriminatedUnion('kind', [
    z.object({ ...common, kind: z.literal('memory_pressure'), evidence: z.object({
      level: z.enum(['elevated', 'critical']), sustainMs: z.number().finite().positive(),
      swapUsedBytes: z.number().finite().nonnegative().optional(), swapTotalBytes: z.number().finite().nonnegative().optional(),
    }).strict() }).strict(),
    z.object({ ...common, kind: z.literal('cpu_busy'), evidence: z.object({
      abovePct: z.number().finite().min(1).max(100), sustainMs: z.number().finite().positive(),
      busyPct: z.number().finite().min(0).max(100),
    }).strict() }).strict(),
    z.object({ ...common, kind: z.literal('disk_nearly_full'), volumeId: z.string().min(1),
      volumeLabel: z.string().optional(), evidence: z.object({
        freeBytes: z.number().finite().nonnegative(), totalBytes: z.number().finite().nonnegative(),
        threshold: MachineVitalsDiskThresholdV1Schema,
      }).strict() }).strict(),
  ]).refine(notice => notice.since <= notice.at, { path: ['since'], message: 'Evidence window starts after occurrence' });
});
export type MachineVitalsNotificationV1 = z.infer<typeof MachineVitalsNotificationV1Schema>;

/** Closed routing envelope; the transport may add the known Home address. */
export const MachineVitalsPushRoutingDataV1Schema = lazyZodSchema(() => z.object({
  topic: z.literal('resource_limit'), kind: z.enum(['memory_pressure', 'disk_nearly_full', 'cpu_busy']),
  phase: z.enum(['started', 'recovered']), machineId: z.string().min(1), notificationId: z.string().min(1),
  nextSteps: z.array(z.enum(['review_processes', 'turn_on_guard', 'free_up_space'])),
  machineVitals: MachineVitalsNotificationV1Schema.optional(),
  serverId: z.string().min(1).optional(), serverUrl: z.string().url().optional(),
}).strict().superRefine((data, ctx) => {
  const notice = data.machineVitals;
  if (notice && (notice.machineId !== data.machineId || notice.kind !== data.kind || notice.phase !== data.phase)) {
    ctx.addIssue({ code: 'custom', path: ['machineVitals'], message: 'Notice must match routing identity' });
  }
}));
export type MachineVitalsPushRoutingDataV1 = z.infer<typeof MachineVitalsPushRoutingDataV1Schema>;

const guardWarningCommon = {
  topic: z.literal('guard_stop_warning'), machineId: z.string().min(1),
  stopAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  idleMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
};
export const GuardStopWarningNotificationV1Schema = lazyZodSchema(() => z.union([
  z.object({ ...guardWarningCommon, sessionId: z.string().min(1), rule: z.enum(['idle_sessions', 'memory_guard']),
    // Words for the notification's own text only; never part of its routing data.
    sessionTitle: z.string().optional(), machineName: z.string().optional() }).strict(),
  z.object({ ...guardWarningCommon, terminalId: z.string().min(1), terminalKey: z.string().min(1).max(2000),
    rule: z.literal('idle_terminals') }).strict(),
]));
export type GuardStopWarningNotificationV1 = z.infer<typeof GuardStopWarningNotificationV1Schema>;
export const GuardAttentionNotificationV1Schema = lazyZodSchema(() => z.object({
  topic: z.literal('guard_attention'), machineId: z.string().min(1), sessionId: z.string().min(1),
  kind: z.enum(['ceiling_near', 'ceiling_reached']),
}).strict());
export type GuardAttentionNotificationV1 = z.infer<typeof GuardAttentionNotificationV1Schema>;

/** One occurrence identifier is reused by push, desktop and state-change dismissal. */
export function guardStopWarningNotificationIdV1(warning: GuardStopWarningNotificationV1): string {
  return warning.rule === 'idle_terminals'
    ? `guard-stop:terminal:${JSON.stringify([warning.machineId, warning.terminalKey, warning.terminalId, warning.stopAt])}`
    : `guard-stop:${warning.sessionId}:${warning.stopAt}`;
}

export function buildGuardStopWarningActionsV1(warning: GuardStopWarningNotificationV1) {
  return warning.rule === 'idle_terminals' ? {
    keepRunning: { actionId: 'machines.guard.idleStop.keepRunning' as const,
      input: { machineId: warning.machineId, terminalKey: warning.terminalKey } },
    stopNow: { actionId: 'machines.terminal.close' as const,
      input: { machineId: warning.machineId, terminalId: warning.terminalId } },
  } : {
    keepRunning: { actionId: 'machines.guard.idleStop.keepRunning' as const,
      input: { machineId: warning.machineId, sessionId: warning.sessionId } },
    stopNow: { actionId: 'session.stop' as const, input: { sessionId: warning.sessionId } },
  };
}

export function buildGuardStopWarningPushDataV1(event: GuardStopWarningNotificationV1) {
  const parsed = GuardStopWarningNotificationV1Schema.parse(event);
  const warning = parsed.rule === 'idle_terminals' ? parsed : (({ sessionTitle: _title, machineName: _machine, ...routing }) => routing)(parsed);
  return { ...warning, categoryId: PUSH_NOTIFICATION_CATEGORY_IDS.guardStopWarningV1,
    notificationId: guardStopWarningNotificationIdV1(warning), actions: buildGuardStopWarningActionsV1(warning) };
}

const guardPushEnvelope = {
  categoryId: z.literal(PUSH_NOTIFICATION_CATEGORY_IDS.guardStopWarningV1), notificationId: z.string().min(1),
  serverId: z.string().min(1).optional(), serverUrl: z.string().url().optional(),
  actions: z.object({
    keepRunning: z.object({ actionId: z.literal('machines.guard.idleStop.keepRunning'),
      input: z.lazy(() => getActionSpec('machines.guard.idleStop.keepRunning').inputSchema) }).strict(),
    stopNow: z.union([
      z.object({ actionId: z.literal('session.stop'), input: z.lazy(() => getActionSpec('session.stop').inputSchema) }).strict(),
      // Push carries a URL; its recipient resolves the device-local Home id before Action admission.
      z.object({ actionId: z.literal('machines.terminal.close'),
        input: z.lazy(() => MACHINE_TERMINAL_ACTION_INPUT_SCHEMAS['machines.terminal.close'].omit({ serverId: true })) }).strict(),
    ]),
  }).strict(),
};
export const GuardStopWarningPushDataV1Schema = lazyZodSchema(() => z.union([
  z.object({ ...guardWarningCommon, ...guardPushEnvelope, sessionId: z.string().min(1), rule: z.enum(['idle_sessions', 'memory_guard']) }).strict(),
  z.object({ ...guardWarningCommon, ...guardPushEnvelope, terminalId: z.string().min(1), terminalKey: z.string().min(1).max(2000), rule: z.literal('idle_terminals') }).strict(),
]).superRefine((data, context) => {
  const expected = buildGuardStopWarningActionsV1(data);
  if (data.notificationId !== guardStopWarningNotificationIdV1(data)
    || !sameStrictJsonValue(data.actions, expected)) {
    context.addIssue({ code: 'custom', message: 'Warning occurrence and actions must match the exact target' });
  }
}));
export type GuardStopWarningPushDataV1 = z.infer<typeof GuardStopWarningPushDataV1Schema>;

/** Home is already admitted from notification routing, never substituted from the active Home. */
export function readGuardStopWarningPushActionV1(data: unknown, action: 'keepRunning' | 'stopNow',
  home: Readonly<{ serverId: string }>) {
  const parsed = GuardStopWarningPushDataV1Schema.safeParse(data);
  if (!parsed.success) return null;
  const serverId = MACHINE_TERMINAL_ACTION_INPUT_SCHEMAS['machines.terminal.close'].shape.serverId.safeParse(home?.serverId);
  if (!serverId.success) return null;
  const target = buildGuardStopWarningActionsV1(parsed.data)[action];
  const qualified = { ...target, input: { ...target.input, serverId: serverId.data } };
  return getActionSpec(target.actionId).inputSchema.safeParse(qualified.input).success ? qualified : null;
}

/** Requires a successfully read current owner snapshot; absence here means cleared, not an unavailable read. */
export function isGuardStopWarningCurrentV1(data: unknown, current: Readonly<{
  machineId: string; sessionId?: string; terminalId?: string; terminalKey?: string; state: unknown;
}>): boolean {
  const parsed = GuardStopWarningPushDataV1Schema.safeParse(data);
  if (!parsed.success || parsed.data.machineId !== current.machineId) return false;
  const warning = parsed.data;
  const state = warning.rule === 'idle_terminals'
    ? TerminalGuardStateV1Schema.safeParse(current.state) : SessionGuardStateV1Schema.safeParse(current.state);
  return state.success && state.data.kind === 'stopping' && state.data.stopAt === warning.stopAt
    && state.data.rule === warning.rule && (warning.rule === 'idle_terminals'
      ? warning.terminalId === current.terminalId && warning.terminalKey === current.terminalKey
      : warning.sessionId === current.sessionId);
}

/** The public episode summary deliberately excludes private activity rows and subject labels. */
export const MachineGuardActivityNotificationV1Schema = lazyZodSchema(() => z.object({
  topic: z.literal('machine_guard_activity'), machineId: z.string().min(1), episodeId: z.string().min(1),
  freedBytes: z.number().finite().nonnegative(), outOfSteps: z.boolean(),
  counts: z.object({ stoppedSessions: z.number().int().nonnegative(), closedBrowsers: z.number().int().nonnegative(),
    stoppedServices: z.number().int().nonnegative(), stoppedLeftBehind: z.number().int().nonnegative() }).strict(),
}).strict());
export type MachineGuardActivityNotificationV1 = z.infer<typeof MachineGuardActivityNotificationV1Schema>;

export const ActivityWebhookTopicSchema = lazyZodSchema(() => z.enum([
  'ready',
  'permission_request',
  'user_action_request',
  'connected_service_account_switch',
  'connected_service_credential_health',
  'connected_service_quota_blocked',
  'connected_service_quota_recovered',
  'connected_service_usage',
  'workflow_run_update',
  'notify_me',
  'guard_stop_warning',
  'guard_attention',
  'machine_guard_activity',
  'resource_limit',
]));

export type ActivityWebhookTopic = z.infer<typeof ActivityWebhookTopicSchema>;

export const WorkflowRunUpdateKindV1Schema = lazyZodSchema(() => z.enum([
  'completed',
  'completed_with_failures',
  'failed',
  'outcome_uncertain',
  'paused',
  'interrupted',
  'review_required',
]));
export type WorkflowRunUpdateKindV1 = z.infer<typeof WorkflowRunUpdateKindV1Schema>;

/**
 * Safe outbound reason projection. Only the machine-readable code crosses the
 * notification boundary; private messages and diagnostics remain in Run detail.
 */
export const WorkflowRunUpdateReasonV1Schema = lazyZodSchema(() => z.object({
  code: z.string().min(1),
}).strict());
export type WorkflowRunUpdateReasonV1 = z.infer<typeof WorkflowRunUpdateReasonV1Schema>;

export const WorkflowRunUpdateNotificationV1Schema = lazyZodSchema(() => z.object({
  topic: z.literal('workflow_run_update'),
  runId: WorkflowRunIdV1Schema,
  updateKind: WorkflowRunUpdateKindV1Schema,
  reason: WorkflowRunUpdateReasonV1Schema.optional(),
}).strict());
export type WorkflowRunUpdateNotificationV1 = z.infer<typeof WorkflowRunUpdateNotificationV1Schema>;

const ActivityWebhookContentV1Schema = lazyZodSchema(() => z.object({
  title: z.string(),
  body: z.string(),
}));

const WorkflowActivityWebhookContentV1Schema = lazyZodSchema(() => z.object({
  title: z.string(),
  body: z.string(),
}).strict());

const ActivityWebhookSessionV1Schema = lazyZodSchema(() => z.object({
  sessionId: z.string().trim().min(1),
  title: z.string().nullable().optional(),
}));

const ActivityWebhookRequestV1Schema = lazyZodSchema(() => z.object({
  requestId: z.string().trim().min(1),
  kind: z.enum(['permission', 'user_action']),
  toolName: z.string().trim().min(1),
  toolDetails: z.string().nullable().optional(),
}));

const ActivityWebhookOrdinaryTopicSchema = lazyZodSchema(() => ActivityWebhookTopicSchema.exclude(['workflow_run_update']));

const ActivityWebhookOrdinaryPayloadV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1).default(1),
  channelId: z.string().trim().min(1),
  createdAt: z.number().int().nonnegative(),
  topic: ActivityWebhookOrdinaryTopicSchema,
  content: ActivityWebhookContentV1Schema,
  session: ActivityWebhookSessionV1Schema.optional(),
  request: ActivityWebhookRequestV1Schema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  navigation: z.object({
    sessionId: z.string().trim().min(1).optional(),
    requestId: z.string().trim().min(1).optional(),
    runId: WorkflowRunIdV1Schema.optional(),
  }),
}));

export const WorkflowRunUpdateWebhookPayloadV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1).default(1),
  channelId: z.string().trim().min(1),
  createdAt: z.number().int().nonnegative(),
  topic: z.literal('workflow_run_update'),
  content: WorkflowActivityWebhookContentV1Schema,
  workflowRun: WorkflowRunUpdateNotificationV1Schema.omit({ topic: true }),
  navigation: z.object({
    runId: WorkflowRunIdV1Schema,
  }).strict(),
}).strict());

export const ActivityWebhookPayloadV1Schema = lazyZodSchema(() => z.discriminatedUnion('topic', [
  ActivityWebhookOrdinaryPayloadV1Schema,
  WorkflowRunUpdateWebhookPayloadV1Schema,
]));

export type ActivityWebhookPayloadV1 = z.infer<typeof ActivityWebhookPayloadV1Schema>;

export function buildActivityWebhookPayload(params: Readonly<{
  channelId: string;
  createdAt: number;
  topic: ActivityWebhookTopic;
  content: Readonly<{ title: string; body: string }>;
  session?: Readonly<{ sessionId: string; title?: string | null }> | null;
  request?: Readonly<{
    requestId: string;
    kind: 'permission' | 'user_action';
    toolName: string;
    toolDetails?: string | null;
  }> | null;
  workflowRun?: Readonly<{
    runId: string;
    updateKind: WorkflowRunUpdateKindV1;
    reason?: WorkflowRunUpdateReasonV1;
  }> | null;
  metadata?: Readonly<Record<string, unknown>> | undefined;
  notificationOpen?: Readonly<{ kind: 'session'; sessionId: string }> | Readonly<{ kind: 'workflow_run'; runId: string }>;
}>): ActivityWebhookPayloadV1 {
  const common = {
    v: 1,
    channelId: params.channelId,
    createdAt: params.createdAt,
    topic: params.topic,
    content: {
      title: params.content.title,
      body: params.content.body,
    },
  } as const;
  if (params.topic === 'workflow_run_update') {
    return ActivityWebhookPayloadV1Schema.parse({
      ...common,
      workflowRun: params.workflowRun,
      navigation: { runId: params.workflowRun?.runId },
    });
  }
  return ActivityWebhookPayloadV1Schema.parse({
    ...common,
    session: params.session
      ? {
        sessionId: params.session.sessionId,
        title: params.session.title ?? null,
      }
      : undefined,
    request: params.request
      ? {
        requestId: params.request.requestId,
        kind: params.request.kind,
        toolName: params.request.toolName,
        toolDetails: params.request.toolDetails ?? null,
      }
      : undefined,
    metadata: params.metadata,
    navigation: {
      sessionId: params.session?.sessionId,
      requestId: params.request?.requestId,
      ...(params.topic === 'notify_me' && params.notificationOpen?.kind === 'session'
        ? { sessionId: params.notificationOpen.sessionId } : {}),
      ...(params.topic === 'notify_me' && params.notificationOpen?.kind === 'workflow_run'
        ? { runId: params.notificationOpen.runId } : {}),
    },
  });
}
