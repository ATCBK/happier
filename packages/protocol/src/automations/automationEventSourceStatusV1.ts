import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { PluginMachineMaterializationRefV1Schema } from '../plugins/availability/materializationRefV1.js';
import { PluginSourceCustodyV1Schema } from '../plugins/runtime/sourceCustody.js';
import { AutomationIdV1Schema } from './automationIdV1.js';
import { AutomationTriggerIdSchema, AutomationTriggerRevisionSchema } from './automationTriggerIdentity.js';
import { AutomationQualifiedPluginContributionRefV1Schema, AutomationSourceSelectorIdV1Schema } from './automationEventDeclarationV1.js';
import { AutomationNonnegativeSafeIntegerV1Schema as NONNEGATIVE_SAFE_INTEGER_SCHEMA } from './automationResultDeliveryV1.js';

const MAX_SIGNED_BIGINT_DECIMAL = '9223372036854775807';
export const UNSIGNED_DECIMAL_BIGINT_SCHEMA = z.string().check(z.regex(/^(?:0|[1-9][0-9]*)$/u), z.maxLength(MAX_SIGNED_BIGINT_DECIMAL.length), z.refine((value) => (
    value.length < MAX_SIGNED_BIGINT_DECIMAL.length || value <= MAX_SIGNED_BIGINT_DECIMAL
  )));

export const AutomationEventSourceStatusStateV1Schema = lazyZodSchema(() => z.enum([
  'uninitialized',
  'baselined',
  'observing',
  'backingOff',
  'attention',
]));
export type AutomationEventSourceStatusStateV1 = z.infer<typeof AutomationEventSourceStatusStateV1Schema>;

export const AutomationEventSourceStatusCodeV1Schema = lazyZodSchema(() => z.enum([
  'none',
  'credentialMissing',
  'credentialRevoked',
  'rateLimited',
  'historyGap',
  'capacityBlocked',
  'definitionStale',
  'sourceContractIncompatible',
  'admissionUnavailable',
]));
export type AutomationEventSourceStatusCodeV1 = z.infer<
  typeof AutomationEventSourceStatusCodeV1Schema
>;

export const AutomationEventSourceCatalogStatusStateV1Schema = lazyZodSchema(() => z.enum([
  'current',
  'reconciling',
  'reconciliationLate',
]));
export type AutomationEventSourceCatalogStatusStateV1 = z.infer<
  typeof AutomationEventSourceCatalogStatusStateV1Schema
>;

export const AutomationEventSourceStatusV1Schema = lazyZodSchema(() => z.strictObject({
  automationId: asProtocolZod(AutomationIdV1Schema),
  triggerId: AutomationTriggerIdSchema,
  triggerRevision: AutomationTriggerRevisionSchema,
  eventRef: asProtocolZod(AutomationQualifiedPluginContributionRefV1Schema),
  sourceSelectorId: AutomationSourceSelectorIdV1Schema,
  reporterMaterializationRef: PluginMachineMaterializationRefV1Schema,
  reporterSourceCustody: PluginSourceCustodyV1Schema,
  state: AutomationEventSourceStatusStateV1Schema,
  code: z.nullable(z.enum(AutomationEventSourceStatusCodeV1Schema.options.filter((value): value is Exclude<(typeof AutomationEventSourceStatusCodeV1Schema.options)[number], 'none'> => !(['none'] as readonly string[]).includes(value)))),
  lastObservedAt: z.nullable(NONNEGATIVE_SAFE_INTEGER_SCHEMA),
  lastDispositionAt: z.nullable(NONNEGATIVE_SAFE_INTEGER_SCHEMA),
  nextRetryAt: z.nullable(NONNEGATIVE_SAFE_INTEGER_SCHEMA),
  observedCount: NONNEGATIVE_SAFE_INTEGER_SCHEMA,
  admittedCount: NONNEGATIVE_SAFE_INTEGER_SCHEMA,
  skippedCount: NONNEGATIVE_SAFE_INTEGER_SCHEMA,
  revision: NONNEGATIVE_SAFE_INTEGER_SCHEMA,
}));
export type AutomationEventSourceStatusV1 = z.infer<typeof AutomationEventSourceStatusV1Schema>;
