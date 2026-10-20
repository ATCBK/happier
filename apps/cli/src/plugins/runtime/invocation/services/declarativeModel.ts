import {
    createStablePluginDeclarativeModel as createProtocolDeclarativeModel,
    type StablePluginQualifiedReference,
    type StablePluginAvailabilityInput,
    type StablePluginDeclarativeModel,
} from '@happier-dev/protocol/plugins/contributions/ui/declarativeModel';
import { PluginUiDeclarationProjectionErrorV1 } from '@happier-dev/protocol/plugins/contributions/ui/settingsDescriptors';
export type {
    StablePluginDeclarativeTone,
    StablePluginDeclarativeActionVariant,
    StablePluginDeclarativeState,
    StablePluginDeclarativeIcon,
    StablePluginDeclarativeMetadataEntry,
    StablePluginQualifiedReference,
    StablePluginDeclarativeStateNode,
    StablePluginDeclarativeTargetedSurfaceNode,
    StablePluginDeclarativeActionNode,
    StablePluginDeclarativeNode,
    StablePluginAvailabilityInput,
    StablePluginDeclarativeActionBinding,
    StablePluginDeclarativeActionPresentation,
    StablePluginDeclarativeDestinationBinding,
    StablePluginDeclarativeSettingsBinding,
    StablePluginDeclarativeInventory,
    StablePluginDeclarativeModel,
} from '@happier-dev/protocol/plugins/contributions/ui/declarativeModel';
import { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { createPluginContributionIdentity } from '@happier-dev/protocol/plugins/contribution-identity';
import { isValidPluginJsonSchemaValue } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import type { PluginDeclarativeQualifiedReferenceV1 } from '@happier-dev/protocol/plugins/contributions/ui/declarativeDocument';
import { PluginIdSchema } from '@happier-dev/protocol/plugins/plugin-id';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { PluginContributionIdentityV1, PluginLocalizedStringV2 } from '@happier-dev/protocol';
import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';

import { clonePluginPlainData } from '../../plainData';
import {
    HostStructuredMessageDescriptorV1Schema,
    MAX_HOST_STRUCTURED_MESSAGE_REFERENCES_V1,
    type HostStructuredMessageDescriptorV1,
} from './structuredMessageDescriptor';

const MAX_STRUCTURED_MESSAGE_PAYLOAD_BYTES = 1024 * 1024;
const MAX_FALLBACK_TEMPLATE_BYTES = 4 * 1024;
const MAX_GENERATION_LENGTH = 256;
const textEncoder = new TextEncoder();

type PluginContributionReference = NonNullable<HostStructuredMessageDescriptorV1['actions']>[number];

export type StablePluginStructuredMessageModel = Readonly<{
    identity: Readonly<{
        pluginId: string;
        localId: string;
        qualifiedId: string;
        occurrenceId: string;
    }>;
    kind: string;
    title: PluginLocalizedStringV2;
    description?: PluginLocalizedStringV2;
    payload: JsonValue;
    renderer: StablePluginQualifiedReference;
    actions: readonly (StablePluginQualifiedReference & Readonly<{ enabled: boolean }>)[];
    resources: readonly StablePluginQualifiedReference[];
    fallback: HostStructuredMessageDescriptorV1['fallback'];
    visible: boolean;
    metadata?: Readonly<Record<string, JsonValue>>;
}>;

function modelError(code: string, message: string): PluginError {
    return new PluginError({ code, message });
}

function cloneDomainPlainData<T>(
    value: T,
    code: string,
    path: string,
): T {
    return clonePluginPlainData(value, {
        path,
        invalid: (message) => modelError(code, message),
    });
}

function normalizePluginId(pluginId: string): string {
    const parsed = PluginIdSchema.safeParse(pluginId);
    if (!parsed.success) throw modelError('plugin_declarative_identity_invalid', 'Plugin id is invalid');
    return parsed.data;
}

function normalizeOccurrenceId(occurrenceId: string): string {
    if (typeof occurrenceId !== 'string'
        || occurrenceId.trim().length === 0
        || occurrenceId.length > MAX_GENERATION_LENGTH) {
        throw modelError('plugin_declarative_generation_invalid', 'Plugin occurrenceId is invalid');
    }
    return occurrenceId;
}

function qualifiedReference(
    identity: PluginContributionIdentityV1,
    occurrenceId: string,
): StablePluginQualifiedReference;
function qualifiedReference(
    identity: PluginContributionIdentityV1,
    occurrenceId: string | undefined,
): PluginDeclarativeQualifiedReferenceV1;
function qualifiedReference(
    identity: PluginContributionIdentityV1,
    occurrenceId: string | undefined,
): PluginDeclarativeQualifiedReferenceV1 {
    return Object.freeze({
        identity: Object.freeze({ ...identity }),
        qualifiedId: buildQualifiedPluginContributionKey(identity),
        ...(occurrenceId === undefined ? {} : { occurrenceId }),
    });
}

function normalizeReference(
    ownerPluginId: string,
    reference: PluginContributionReference,
): PluginContributionIdentityV1 {
    return createPluginContributionIdentity(typeof reference === 'string'
        ? { pluginId: ownerPluginId, localId: reference }
        : reference);
}

function buildIdentityInventory(params: Readonly<{
    values: readonly PluginContributionIdentityV1[];
    domain: 'action' | 'destination' | 'resource' | 'renderer';
    invalidPlainDataCode: string;
}>): ReadonlySet<string> {
    const plainValues = cloneDomainPlainData(
        params.values,
        params.invalidPlainDataCode,
        params.domain,
    );
    if (!Array.isArray(plainValues)) {
        throw modelError(`plugin_${params.domain}_identity_invalid`, `${params.domain} identity inventory is invalid`);
    }
    const keys = new Set<string>();
    for (const value of plainValues) {
        let identity: PluginContributionIdentityV1;
        try {
            identity = createPluginContributionIdentity(value);
        } catch {
            throw modelError(`plugin_${params.domain}_identity_invalid`, `${params.domain} identity is invalid`);
        }
        const key = buildQualifiedPluginContributionKey(identity);
        if (keys.has(key)) {
            throw modelError(`plugin_${params.domain}_identity_duplicate`, `Duplicate ${params.domain} '${key}'`);
        }
        keys.add(key);
    }
    return keys;
}

function normalizeAvailability(
    availability: StablePluginAvailabilityInput | undefined,
    actionKeys: ReadonlySet<string>,
    invalidPlainDataCode: string,
): StablePluginAvailabilityInput | undefined {
    if (availability === undefined) return undefined;
    const plain = cloneDomainPlainData(
        availability,
        invalidPlainDataCode,
        'availability',
    );
    if (plain === null || typeof plain !== 'object' || Array.isArray(plain)) {
        throw modelError('plugin_declarative_availability_invalid', 'Availability input is invalid');
    }
    const keys = Object.keys(plain);
    if (keys.some((key) => key !== 'visible' && key !== 'enabledActions')
        || typeof plain.visible !== 'boolean'
        || !plain.enabledActions
        || typeof plain.enabledActions !== 'object'
        || Array.isArray(plain.enabledActions)) {
        throw modelError('plugin_declarative_availability_invalid', 'Availability input is invalid');
    }
    for (const [key, enabled] of Object.entries(plain.enabledActions)) {
        if (!actionKeys.has(key) || typeof enabled !== 'boolean') {
            throw modelError('plugin_declarative_availability_invalid', `Availability action '${key}' is invalid`);
        }
    }
    return plain;
}

export function createStablePluginDeclarativeModel(params: Parameters<typeof createProtocolDeclarativeModel>[0]): StablePluginDeclarativeModel {
    try {
        return createProtocolDeclarativeModel(params);
    } catch (error) {
        if (error instanceof PluginUiDeclarationProjectionErrorV1) {
            throw modelError(error.code, error.message);
        }
        throw error;
    }
}

function compilePayloadValidator(schema: HostStructuredMessageDescriptorV1['payloadSchema']) {
    try {
        return compilePluginJsonSchema(schema);
    } catch {
        throw modelError('plugin_structured_message_schema_invalid', 'Structured-message payload schema is invalid');
    }
}

function normalizeReferencedValues(params: Readonly<{
    ownerPluginId: string;
    occurrenceId: string;
    references: readonly PluginContributionReference[];
    inventory: ReadonlySet<string>;
    kind: 'action' | 'resource';
    enabledActions?: Readonly<Record<string, boolean>>;
}>): readonly (StablePluginQualifiedReference & Readonly<{ enabled?: boolean }>)[] {
    if (params.references.length > MAX_HOST_STRUCTURED_MESSAGE_REFERENCES_V1) {
        throw modelError(`plugin_structured_message_${params.kind}s_bounded`, `Too many structured-message ${params.kind}s`);
    }
    const seen = new Set<string>();
    return Object.freeze(params.references.map((reference) => {
        let identity: PluginContributionIdentityV1;
        try {
            identity = normalizeReference(params.ownerPluginId, reference);
        } catch {
            throw modelError(
                `plugin_structured_message_${params.kind}_identity_invalid`,
                `Structured-message ${params.kind} identity is invalid`,
            );
        }
        const qualifiedId = buildQualifiedPluginContributionKey(identity);
        if (!params.inventory.has(qualifiedId)) {
            throw modelError(
                `plugin_structured_message_${params.kind}_missing`,
                `Structured-message ${params.kind} '${qualifiedId}' is not declared`,
            );
        }
        if (seen.has(qualifiedId)) {
            throw modelError(
                `plugin_structured_message_${params.kind}_duplicate`,
                `Structured-message ${params.kind} '${qualifiedId}' is duplicated`,
            );
        }
        seen.add(qualifiedId);
        const normalized = qualifiedReference(identity, params.occurrenceId);
        return params.kind === 'action'
            ? Object.freeze({ ...normalized, enabled: params.enabledActions?.[qualifiedId] === true })
            : normalized;
    }));
}

export function createStablePluginStructuredMessageModel(params: Readonly<{
    pluginId: string;
    occurrenceId: string;
    descriptor: HostStructuredMessageDescriptorV1;
    value: Readonly<{
        kind: string;
        payload: JsonValue;
        resources?: readonly PluginContributionReference[];
    }>;
    actions: readonly PluginContributionIdentityV1[];
    resources: readonly PluginContributionIdentityV1[];
    renderers: readonly PluginContributionIdentityV1[];
    availability?: StablePluginAvailabilityInput;
}>): StablePluginStructuredMessageModel {
    const pluginId = normalizePluginId(params.pluginId);
    const occurrenceId = normalizeOccurrenceId(params.occurrenceId);
    const descriptor = cloneDomainPlainData(
        params.descriptor,
        'plugin_structured_message_invalid_plain_data',
        'descriptor',
    );
    if (!HostStructuredMessageDescriptorV1Schema.safeParse(descriptor).success) {
        throw modelError('plugin_structured_message_descriptor_invalid', 'Structured-message descriptor is invalid');
    }
    const value = cloneDomainPlainData(
        params.value,
        'plugin_structured_message_invalid_plain_data',
        'value',
    );
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw modelError('plugin_structured_message_value_invalid', 'Structured-message value is invalid');
    }
    const valueKeys = Object.keys(value);
    if (valueKeys.some((key) => key !== 'kind' && key !== 'payload' && key !== 'resources')
        || typeof value.kind !== 'string'
        || value.payload === undefined
        || (value.resources !== undefined && !Array.isArray(value.resources))) {
        throw modelError('plugin_structured_message_value_invalid', 'Structured-message value is invalid');
    }
    if (value.kind !== descriptor.kind) {
        throw modelError('plugin_structured_message_kind_mismatch', 'Structured-message kind does not match its descriptor');
    }
    const payloadBytes = textEncoder.encode(JSON.stringify(value.payload)).byteLength;
    if (payloadBytes > MAX_STRUCTURED_MESSAGE_PAYLOAD_BYTES) {
        throw modelError('plugin_structured_message_payload_bounded', 'Structured-message payload is too large');
    }
    if (!isValidPluginJsonSchemaValue(compilePayloadValidator(descriptor.payloadSchema), value.payload)) {
        throw modelError('plugin_structured_message_payload_invalid', 'Structured-message payload is invalid');
    }
    if (descriptor.fallback.kind === 'summary'
        && textEncoder.encode(descriptor.fallback.template).byteLength > MAX_FALLBACK_TEMPLATE_BYTES) {
        throw modelError('plugin_structured_message_fallback_bounded', 'Structured-message fallback is too large');
    }

    const actionKeys = buildIdentityInventory({
        values: params.actions,
        domain: 'action',
        invalidPlainDataCode: 'plugin_structured_message_invalid_plain_data',
    });
    const resourceKeys = buildIdentityInventory({
        values: params.resources,
        domain: 'resource',
        invalidPlainDataCode: 'plugin_structured_message_invalid_plain_data',
    });
    const rendererKeys = buildIdentityInventory({
        values: params.renderers,
        domain: 'renderer',
        invalidPlainDataCode: 'plugin_structured_message_invalid_plain_data',
    });
    const availability = normalizeAvailability(
        params.availability,
        actionKeys,
        'plugin_structured_message_invalid_plain_data',
    );
    const rendererIdentity = createPluginContributionIdentity({ pluginId, localId: descriptor.renderer });
    const rendererKey = buildQualifiedPluginContributionKey(rendererIdentity);
    if (!rendererKeys.has(rendererKey)) {
        throw modelError('plugin_structured_message_renderer_missing', `Renderer '${rendererKey}' is not declared`);
    }
    const actions = normalizeReferencedValues({
        ownerPluginId: pluginId,
        occurrenceId,
        references: descriptor.actions ?? [],
        inventory: actionKeys,
        kind: 'action',
        enabledActions: availability?.enabledActions,
    }) as readonly (StablePluginQualifiedReference & Readonly<{ enabled: boolean }>)[];
    const resources = normalizeReferencedValues({
        ownerPluginId: pluginId,
        occurrenceId,
        references: value.resources ?? [],
        inventory: resourceKeys,
        kind: 'resource',
    }) as readonly StablePluginQualifiedReference[];
    const identity = createPluginContributionIdentity({ pluginId, localId: descriptor.id });
    return Object.freeze({
        identity: Object.freeze({
            ...identity,
            qualifiedId: buildQualifiedPluginContributionKey(identity),
            occurrenceId,
        }),
        kind: descriptor.kind,
        title: descriptor.title,
        ...(descriptor.description ? { description: descriptor.description } : {}),
        payload: value.payload,
        renderer: qualifiedReference(rendererIdentity, occurrenceId),
        actions,
        resources,
        fallback: descriptor.fallback,
        visible: descriptor.availability ? availability?.visible === true : (availability?.visible ?? true),
        ...(descriptor.metadata ? { metadata: descriptor.metadata } : {}),
    });
}
