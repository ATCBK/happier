import { z } from 'zod/mini';

import { normalizePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { PluginContributionLocalIdSchema } from '@happier-dev/protocol/plugins/contribution-identity';
import { PluginIdSchema } from '@happier-dev/protocol/plugins/plugin-id';
import type { PluginJsonSchemaV2 } from '@happier-dev/protocol/plugins/manifest';

import { asHostProtocolZod } from '../../protocolComposableZodAdapter';

export const MAX_HOST_STRUCTURED_MESSAGE_REFERENCES_V1 = 64;

const HostPluginContributionLocalIdSchema = asHostProtocolZod(PluginContributionLocalIdSchema);
const HostPluginIdSchema = asHostProtocolZod(PluginIdSchema);

type HostJsonValue = null | boolean | number | string | HostJsonValue[] | { [key: string]: HostJsonValue };

const HostJsonValueSchema: z.ZodMiniType<HostJsonValue> = z.lazy(() => z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(HostJsonValueSchema),
    z.record(z.string(), HostJsonValueSchema),
]));

const HostLocalizedStringSchema = z.union([
    z.string().check(z.trim(), z.minLength(1)),
    z.strictObject({ key: z.string().check(z.trim(), z.minLength(1)), fallback: z.string().check(z.trim(), z.minLength(1)) }),
]);

const HostContributionReferenceSchema = z.union([
    HostPluginContributionLocalIdSchema,
    z.strictObject({ pluginId: HostPluginIdSchema, localId: HostPluginContributionLocalIdSchema }),
]);

type HostPolicyExpression =
    | { fact: string; operator: string; value: boolean | string }
    | { all: HostPolicyExpression[] }
    | { any: HostPolicyExpression[] }
    | { not: HostPolicyExpression };

const HostPolicyExpressionSchema: z.ZodMiniType<HostPolicyExpression> = z.lazy(() => z.union([
    z.strictObject({ fact: z.enum(['plugin.enabled', 'session.exists', 'project.exists', 'browser.exists']), operator: z.literal('equals'), value: z.boolean() }),
    z.strictObject({ fact: z.literal('host.platform'), operator: z.enum(['equals', 'notEquals']), value: z.enum(['web', 'ios', 'android', 'desktop']) }),
    z.strictObject({ fact: z.literal('host.feature'), operator: z.literal('enabled'), value: z.string().check(z.trim(), z.minLength(1)) }),
    z.strictObject({ fact: z.enum(['session.agentId', 'session.state', 'project.id', 'machine.id', 'browser.origin']), operator: z.enum(['equals', 'notEquals']), value: z.string() }),
    z.strictObject({ fact: z.literal('session.capability'), operator: z.literal('contains'), value: z.string().check(z.trim(), z.minLength(1)) }),
    z.strictObject({ all: z.array(HostPolicyExpressionSchema) }),
    z.strictObject({ any: z.array(HostPolicyExpressionSchema) }),
    z.strictObject({ not: HostPolicyExpressionSchema }),
]));

const HostAvailabilityDescriptorSchema = z.union([
    z.strictObject({ when: z.optional(HostPolicyExpressionSchema), disabledWhen: z.optional(z.never()), disabledReason: z.optional(z.never()) }),
    z.strictObject({ when: z.optional(HostPolicyExpressionSchema), disabledWhen: HostPolicyExpressionSchema, disabledReason: HostLocalizedStringSchema }),
]);

const HostPluginJsonSchemaV2Schema = z.custom<PluginJsonSchemaV2>((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    try {
        normalizePluginJsonSchema(value);
        return true;
    } catch {
        return false;
    }
}, { message: 'Structured-message payloadSchema must be a supported plugin JSON Schema.' });

/**
 * Host-private descriptor grammar retained only for incumbent message parsing.
 * It is deliberately not part of the plugin manifest or SDK authoring surface.
 */
export const HostStructuredMessageDescriptorV1Schema = z.strictObject({
    id: HostPluginContributionLocalIdSchema,
    title: HostLocalizedStringSchema,
    description: z.optional(HostLocalizedStringSchema),
    kind: z.string().check(z.trim(), z.minLength(1)),
    payloadSchema: HostPluginJsonSchemaV2Schema,
    renderer: HostPluginContributionLocalIdSchema,
    actions: z.optional(z.array(HostContributionReferenceSchema).check(z.maxLength(MAX_HOST_STRUCTURED_MESSAGE_REFERENCES_V1))),
    fallback: z.union([
        z.strictObject({ kind: z.literal('summary'), template: z.string() }),
        z.strictObject({ kind: z.literal('hidden') }),
    ]),
    availability: z.optional(HostAvailabilityDescriptorSchema),
    metadata: z.optional(z.record(z.string(), HostJsonValueSchema)),
});

export type HostStructuredMessageDescriptorV1 = z.infer<typeof HostStructuredMessageDescriptorV1Schema>;
