import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { PluginMachineMaterializationRefV1Schema } from '../plugins/availability/materializationRefV1.js';
import {
  PluginWebhookEndpointIdV1Schema,
  PluginWebhookEndpointSetupV1Schema,
} from '../plugins/webhooks/endpointV1.js';
import {
  AutomationQualifiedPluginContributionRefV1Schema,
  AutomationSourceSelectorIdV1Schema,
} from './automationEventDeclarationV1.js';
import { AutomationEventPositiveSafeIntegerV1Schema } from './automationColumnBoundsV1.js';
import {
  AutomationEventSourceConfigV1Schema,
  AutomationEventSourceDisplayLabelV1Schema,
  AutomationEventSourceInstanceIdV1Schema,
} from './automationEventJsonBoundsV1.js';
import { AutomationEventFilterV1Schema } from './automationEventFilterV1.js';
import {
  ENCRYPTED_STORED_CONTENT_SCHEMA,
  addAutomationStoredEnvelopeUtf8LimitIssue,
} from './automationStoredContentEnvelopeV1.js';
import { AutomationSessionLifecycleConfigurationSchema } from './automationSessionLifecycle.js';
import { AutomationRunLifecycleTriggerSchema, AutomationRunLifecycleTriggerInputSchema } from './automationRunLifecycle.js';
export * from './automationRunLifecycle.js';

const AutomationScheduleSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('cron'),
    scheduleExpr: z.string(),
    everyMs: z.null(),
    timezone: z.nullable(z.string()),
  }),
  z.strictObject({
    kind: z.literal('interval'),
    scheduleExpr: z.null(),
    everyMs: z.number().check(z.int()),
    timezone: z.nullable(z.string()),
  }),
]));

export const AutomationScheduleTriggerSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('schedule'),
  schedule: AutomationScheduleSchema,
}));
export type AutomationScheduleTrigger = z.infer<typeof AutomationScheduleTriggerSchema>;

export const AutomationScheduleTriggerInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AutomationScheduleTriggerSchema, {
  enabled: z.boolean(),
})));
export type AutomationScheduleTriggerInput = z.infer<typeof AutomationScheduleTriggerInputSchema>;

export const AutomationSessionLifecycleTriggerSchema =
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AutomationSessionLifecycleConfigurationSchema, {
    kind: z.literal('sessionLifecycle'),
  })));
export type AutomationSessionLifecycleTrigger = z.infer<
  typeof AutomationSessionLifecycleTriggerSchema
>;

export const AutomationSessionLifecycleTriggerInputSchema =
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AutomationSessionLifecycleTriggerSchema, { enabled: z.boolean() })));
export type AutomationSessionLifecycleTriggerInput = z.infer<
  typeof AutomationSessionLifecycleTriggerInputSchema
>;

/** Stable exact-turn registration refusals derived by the Session owner. */
export const AutomationSessionLifecycleRegistrationErrorCodeSchema = lazyZodSchema(() => z.enum([
  'sourceSessionUnavailable',
  'sourceTurnNotCurrent',
  'sourceTurnUnavailable',
  'sourceTurnNotInProgress',
  'executionTargetInequalityUnproven',
  'sourceMatchesExecutionTarget',
  'session_already_started',
]));
export type AutomationSessionLifecycleRegistrationErrorCode = z.infer<
  typeof AutomationSessionLifecycleRegistrationErrorCodeSchema
>;

export const AutomationPluginEventObservationTransportInputSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('checkpointedPull'),
    watcherMaterializationRef: PluginMachineMaterializationRefV1Schema,
  }),
  z.strictObject({
    kind: z.literal('socket'),
    /** The exact plugin materialization hosting the provider's observation session. */
    watcherMaterializationRef: PluginMachineMaterializationRefV1Schema,
  }),
  z.strictObject({
    kind: z.literal('durablePush'),
    webhookEndpointId: PluginWebhookEndpointIdV1Schema,
    endpointMaterializationRef: PluginMachineMaterializationRefV1Schema,
    webhookRoutingSourceInstanceId: AutomationEventSourceInstanceIdV1Schema,
    setup: PluginWebhookEndpointSetupV1Schema,
  }),
]));
export type AutomationPluginEventObservationTransportInput = z.infer<
  typeof AutomationPluginEventObservationTransportInputSchema
>;

export const AutomationPluginEventDefinitionTriggerSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('pluginEvent'),
  eventRef: asProtocolZod(AutomationQualifiedPluginContributionRefV1Schema),
  sourceInstanceId: AutomationEventSourceInstanceIdV1Schema,
  sourceContractVersion: AutomationEventPositiveSafeIntegerV1Schema,
  sourceConfig: asProtocolZod(AutomationEventSourceConfigV1Schema),
  displayLabel: AutomationEventSourceDisplayLabelV1Schema,
  observationTransport: AutomationPluginEventObservationTransportInputSchema,
  filter: z.nullable(AutomationEventFilterV1Schema),
  maximumObservationAgeMs: z.nullable(z.number().check(z.int(), z.nonnegative(), z.int())),
}));
export type AutomationPluginEventDefinitionTrigger = z.infer<
  typeof AutomationPluginEventDefinitionTriggerSchema
>;

export const AutomationEncryptedTriggerDefinitionEnvelopeV1Schema =
  ENCRYPTED_STORED_CONTENT_SCHEMA.check(z.superRefine((value, context) => {
    addAutomationStoredEnvelopeUtf8LimitIssue(
      value,
      context,
      'Stored Automation envelope exceeds its UTF-8 byte limit',
    );
  }));
export type AutomationEncryptedTriggerDefinitionEnvelopeV1 = z.infer<
  typeof AutomationEncryptedTriggerDefinitionEnvelopeV1Schema
>;

/** The private PR selector shared by comment and failed-check triggers. */
export const AutomationPullRequestTriggerSchema = lazyZodSchema(() => z.strictObject({
  kind: z.enum(['prComment', 'ciFailed']),
  pullRequest: z.strictObject({
    repository: z.string().check(z.minLength(1)),
    number: z.number().check(z.int(), z.positive(), z.int()),
  }),
}));
export type AutomationPullRequestTrigger = z.infer<typeof AutomationPullRequestTriggerSchema>;

export const AutomationPullRequestEncryptedTriggerSchema = lazyZodSchema(() => z.strictObject({
  kind: z.enum(['prComment', 'ciFailed']),
  triggerDefinitionEnvelope: AutomationEncryptedTriggerDefinitionEnvelopeV1Schema,
}));

export const AutomationPullRequestTriggerInputSchema = lazyZodSchema(() => z.union([
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AutomationPullRequestTriggerSchema, { enabled: z.boolean() })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AutomationPullRequestEncryptedTriggerSchema, { enabled: z.boolean() })),
]));
export type AutomationPullRequestTriggerInput = z.infer<typeof AutomationPullRequestTriggerInputSchema>;

/**
 * Ciphertext-blind Event authoring arm. Public routing/currentness facts remain
 * on AutomationTrigger; the exact private definition is sealed to the
 * client-chosen Automation/trigger identity and revision in the canonical
 * stored-content envelope.
 */
export const AutomationPluginEventEncryptedDefinitionTriggerSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('pluginEvent'),
  eventRef: asProtocolZod(AutomationQualifiedPluginContributionRefV1Schema),
  sourceSelectorId: AutomationSourceSelectorIdV1Schema,
  sourceContractVersion: AutomationEventPositiveSafeIntegerV1Schema,
  observationTransport: AutomationPluginEventObservationTransportInputSchema,
  triggerDefinitionEnvelope: AutomationEncryptedTriggerDefinitionEnvelopeV1Schema,
}));
export type AutomationPluginEventEncryptedDefinitionTrigger = z.infer<
  typeof AutomationPluginEventEncryptedDefinitionTriggerSchema
>;

export const AutomationPluginEventDefinitionTriggerInputSchema =
  lazyZodSchema(() => z.union([
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AutomationPluginEventDefinitionTriggerSchema, { enabled: z.boolean() })),
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AutomationPluginEventEncryptedDefinitionTriggerSchema, { enabled: z.boolean() })),
  ]));
export type AutomationPluginEventDefinitionTriggerInput = z.infer<
  typeof AutomationPluginEventDefinitionTriggerInputSchema
>;

export const AutomationTriggerDefinitionSchema = lazyZodSchema(() => z.union([
  AutomationScheduleTriggerSchema,
  AutomationPluginEventDefinitionTriggerSchema,
  AutomationPluginEventEncryptedDefinitionTriggerSchema,
  AutomationSessionLifecycleTriggerSchema,
  AutomationRunLifecycleTriggerSchema,
  AutomationPullRequestTriggerSchema,
  AutomationPullRequestEncryptedTriggerSchema,
]));
export type AutomationTriggerDefinition = z.infer<typeof AutomationTriggerDefinitionSchema>;

export const AutomationTriggerDefinitionInputSchema = lazyZodSchema(() => z.union([
  AutomationScheduleTriggerInputSchema,
  AutomationPluginEventDefinitionTriggerInputSchema,
  AutomationSessionLifecycleTriggerInputSchema,
  AutomationRunLifecycleTriggerInputSchema,
  AutomationPullRequestTriggerInputSchema,
]));
export type AutomationTriggerDefinitionInput = z.infer<
  typeof AutomationTriggerDefinitionInputSchema
>;
