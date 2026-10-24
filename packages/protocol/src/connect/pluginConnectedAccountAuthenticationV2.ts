import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

import { CanonicalHttpOriginSchema } from '../http/canonicalHttpOrigin.js';
import { PluginContributionLocalIdSchema } from '../plugins/contributionIdentity.js';
import {
  PluginConfigurationSettingFieldV2Schema,
  PluginSettingFieldV2Schema,
} from '../plugins/contributions/settings.js';
import {
  PluginJsonValueV2Schema,
  PluginLocalizedStringV2Schema,
} from '../plugins/contributions/publicTypes.js';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";
import { ProviderAccountUsageRecordKeyV1Schema } from './providerAccountUsagePrimitives.js';

const PluginConnectedAccountAuthenticationFieldV2Schema =
  lazyZodSchema(() => z.pipe(PluginSettingFieldV2Schema, z.transform((field) => ({
    ...field,
    secret: field.secret === true,
  }))));

const [
  PluginSecretConfigurationSettingFieldV2Schema,
  PluginPublicConfigurationSettingFieldV2Schema,
] = PluginConfigurationSettingFieldV2Schema._zod.def.options;

const PluginConnectedAccountOriginValueSchemaV2Schema = lazyZodSchema(() => z.strictObject({
  type: z.literal('string'),
  title: z.optional(z.string()),
  description: z.optional(z.string()),
  minLength: z.number().check(z.int(), z.minimum(1)),
  maxLength: z.optional(z.number().check(z.int(), z.nonnegative())),
}));

/**
 * The closed choice set of a fixed-origin field. Its persisted value is the
 * choice, never the origin: a user picking a named deployment is not asked to
 * retype a URL the descriptor already knows.
 */
const PluginConnectedAccountFixedOriginChoiceSchemaV2Schema = lazyZodSchema(() => z.strictObject({
  type: z.literal('string'),
  title: z.optional(z.string()),
  description: z.optional(z.string()),
  enum: z.array(z.string().check(z.minLength(1))).check(z.minLength(1)),
}));

export const PluginConnectedAccountConfigurationFieldV2Schema =
  lazyZodSchema(() => z.union([
    z.pipe(z.extend(PluginSecretConfigurationSettingFieldV2Schema, {
      semantic: z.optional(z.never()),
    }), z.transform((field) => ({
      ...field,
      secret: true as const,
    }))),
    z.pipe(z.extend(PluginPublicConfigurationSettingFieldV2Schema, {
      semantic: z.optional(z.never()),
    }), z.transform((field) => ({
      ...field,
      secret: false as const,
    }))),
    z.pipe(z.extend(z.omit(PluginPublicConfigurationSettingFieldV2Schema, {
        schema: true,
        default: true,
        required: true,
      }), {
        semantic: z.literal('connectedAccountOrigin'),
        schema: PluginConnectedAccountOriginValueSchemaV2Schema,
        default: z.optional(z.never()),
        required: z.literal(true),
      }), z.transform((field) => ({
        ...field,
        secret: false as const,
      }))),
    z.pipe(z.extend(z.omit(PluginPublicConfigurationSettingFieldV2Schema, {
        schema: true,
        default: true,
        required: true,
      }), {
        semantic: z.literal('connectedAccountFixedOrigin'),
        schema: PluginConnectedAccountFixedOriginChoiceSchemaV2Schema,
        originByValue: z.record(z.string().check(z.minLength(1)), CanonicalHttpOriginSchema),
        default: z.optional(z.never()),
        required: z.literal(true),
      }).check(z.superRefine((field, context) => {
        // The choice set and the route table are one declaration seen from two
        // sides. Letting them disagree would leave a pickable value with no
        // route, or a route no user can select.
        const choices = new Set(field.schema.enum);
        const routed = new Set(Object.keys(field.originByValue));
        if (
          choices.size !== field.schema.enum.length
          || choices.size !== routed.size
          || [...choices].some((choice) => !routed.has(choice))
        ) {
          context.addIssue({
            code: 'custom',
            path: ['originByValue'],
            message: 'Fixed-origin choices must declare exactly one origin per distinct choice.',
          });
        }
      })), z.transform((field) => ({
        ...field,
        secret: false as const,
      }))),
    // A configured *service base* is a second, distinct fact from the network
    // origin: a deployment reached beneath a path segment — an Azure DevOps
    // organization or collection, a path-prefixed self-hosted GitLab or Sentry —
    // routes by the base while HostAccess keeps governing by the origin the
    // host derives from it. `connectedAccountOrigin` is deliberately not
    // loosened to carry a path, so `origin` keeps meaning scheme://host[:port].
    z.pipe(z.extend(z.omit(PluginPublicConfigurationSettingFieldV2Schema, {
        schema: true,
        default: true,
        required: true,
      }), {
        semantic: z.literal('connectedAccountBase'),
        schema: PluginConnectedAccountOriginValueSchemaV2Schema,
        default: z.optional(z.never()),
        required: z.literal(true),
      }), z.transform((field) => ({
        ...field,
        secret: false as const,
      }))),
  ]).check(z.superRefine((field, context) => {
      if (field.presentation?.binding !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['presentation', 'binding'],
          message: 'Connected Account configuration fields are already bound to their service or account target.',
        });
      }
    })));
export type PluginConnectedAccountConfigurationFieldV2 =
  z.infer<typeof PluginConnectedAccountConfigurationFieldV2Schema>;

function rejectDuplicateFieldIds(
  fields: readonly Readonly<{ id: string }>[],
  context: z.core.$RefinementCtx,
): void {
  const fieldIds = new Set<string>();
  fields.forEach((field, fieldIndex) => {
    if (fieldIds.has(field.id)) {
      context.addIssue({
        code: 'custom',
        path: [fieldIndex, 'id'],
        message: `Duplicate Connected Account field id '${field.id}'.`,
      });
    }
    fieldIds.add(field.id);
  });
}

const PluginConnectedAccountAuthenticationFieldsV2Schema =
  lazyZodSchema(() => z.array(PluginConnectedAccountAuthenticationFieldV2Schema).check(z.superRefine(rejectDuplicateFieldIds)));

const PluginConnectedAccountConfigurationFieldsV2Schema =
  lazyZodSchema(() => z.array(PluginConnectedAccountConfigurationFieldV2Schema).check(z.minLength(1), z.superRefine(rejectDuplicateFieldIds)));

export const PluginConnectedAccountConfigurationV2Schema = lazyZodSchema(() => z.strictObject({
  scope: z.enum(['service', 'account']),
  changeBehavior: z.enum(['refresh', 'reconnect']),
  fields: PluginConnectedAccountConfigurationFieldsV2Schema,
}));
export type PluginConnectedAccountConfigurationV2 =
  z.infer<typeof PluginConnectedAccountConfigurationV2Schema>;

const PluginConnectedAccountOutcomeReconciliationV2Schema =
  lazyZodSchema(() => z.enum(['providerCheck', 'lateEvidence', 'none']));

export const CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 =
  'happier.team-credential-manual-connected-account-direct.v1' as const;

export const PluginConnectedAccountDirectExportV2Schema = lazyZodSchema(() => z.strictObject({
  contractVersion: z.literal(CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1),
}));
export type PluginConnectedAccountDirectExportV2 = z.infer<
  typeof PluginConnectedAccountDirectExportV2Schema
>;

export const PluginConnectedAccountAuthenticationModeV2Schema =
  lazyZodSchema(() => z.discriminatedUnion('kind', [
    z.strictObject({
      id: asProtocolZod(PluginContributionLocalIdSchema),
      kind: z.literal('manual'),
      title: z.optional(PluginLocalizedStringV2Schema),
      outcomeReconciliation: z.literal('none'),
      fields: PluginConnectedAccountAuthenticationFieldsV2Schema,
      configuration: z.optional(PluginConnectedAccountConfigurationV2Schema),
      directExport: z.optional(PluginConnectedAccountDirectExportV2Schema),
    }),
    z.strictObject({
      id: asProtocolZod(PluginContributionLocalIdSchema),
      kind: z.literal('oauthAuthorizationCode'),
      title: z.optional(PluginLocalizedStringV2Schema),
      callbackUrl: z.optional(z.url().check(z.maxLength(2_048))),
      scopes: z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))),
      pkce: z.literal('required'),
      allowRawAuthorizationCode: z.optional(z.boolean()),
      outcomeReconciliation: PluginConnectedAccountOutcomeReconciliationV2Schema,
      configuration: z.optional(PluginConnectedAccountConfigurationV2Schema),
    }).check(z.superRefine((mode, context) => {
      if (mode.callbackUrl === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['callbackUrl'],
          message: 'Authorization-code authentication requires a declared callback URL.',
        });
      }
    })),
    z.strictObject({
      id: asProtocolZod(PluginContributionLocalIdSchema),
      kind: z.literal('oauthDeviceCode'),
      title: z.optional(PluginLocalizedStringV2Schema),
      scopes: z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))),
      outcomeReconciliation: PluginConnectedAccountOutcomeReconciliationV2Schema,
      configuration: z.optional(PluginConnectedAccountConfigurationV2Schema),
    }),
  ]));
export type PluginConnectedAccountAuthenticationModeV2 =
  z.infer<typeof PluginConnectedAccountAuthenticationModeV2Schema>;

export const PluginConnectedAccountAuthenticationV2Schema = lazyZodSchema(() => z.strictObject({
  defaultModeId: asProtocolZod(PluginContributionLocalIdSchema),
  modes: z.array(PluginConnectedAccountAuthenticationModeV2Schema).check(z.minLength(1)),
  native: z.optional(z.strictObject({ systemTool: z.literal('gh') })),
}).check(z.superRefine((authentication, context) => {
  const modeIds = new Set<string>();
  authentication.modes.forEach((mode, modeIndex) => {
    if (modeIds.has(mode.id)) {
      context.addIssue({
        code: 'custom',
        path: ['modes', modeIndex, 'id'],
        message: `Duplicate Connected Account authentication mode id '${mode.id}'.`,
      });
    }
    modeIds.add(mode.id);
  });
  if (!modeIds.has(authentication.defaultModeId)) {
    context.addIssue({
      code: 'custom',
      path: ['defaultModeId'],
      message: `Default Connected Account authentication mode '${authentication.defaultModeId}' is not declared.`,
    });
  }
})));
export type PluginConnectedAccountAuthenticationV2 =
  z.infer<typeof PluginConnectedAccountAuthenticationV2Schema>;

/**
 * One authored Connected Account descriptor contribution. It lives beside the
 * authentication vocabulary it composes so the whole author-visible Connected
 * Account family has a single narrow Protocol owner; the V2 contribution
 * catalog re-exports it for family registration.
 */
/** Authored provider navigation only; callers never supply or substitute this destination. */
export const ConnectedAccountBillingUrlSchema = lazyZodSchema(() => z.string().check(z.url(), z.refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password;
}, 'Billing destinations must be credential-free HTTPS URLs')));

export const PluginConnectedAccountDescriptorContributionV2Schema = lazyZodSchema(() => z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: PluginLocalizedStringV2Schema,
  description: z.optional(PluginLocalizedStringV2Schema),
  /** Presentation only; omission retains the host's existing service classification. */
  ui: z.optional(z.strictObject({ category: z.literal('cloud-machines') })),
  authentication: PluginConnectedAccountAuthenticationV2Schema,
  usageIdentity: z.optional(z.strictObject({
    providerId: z.optional(ProviderAccountUsageRecordKeyV1Schema.shape.providerId),
    requiredContext: z.optional(z.literal('organization')),
  }).check(z.refine(identity => identity.providerId !== undefined || identity.requiredContext !== undefined))),
  recoveryCredits: z.optional(z.strictObject({ supported: z.literal(true) })),
  billingUrl: z.optional(ConnectedAccountBillingUrlSchema),
  capabilities: z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))),
  metadata: z.optional(z.record(z.string(), PluginJsonValueV2Schema)),
}));
export type PluginConnectedAccountDescriptorContributionV2 =
  z.infer<typeof PluginConnectedAccountDescriptorContributionV2Schema>;
