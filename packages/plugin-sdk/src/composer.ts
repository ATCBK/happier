import type { JsonValue } from './identity.js';
import type { PluginJsonSchema } from './protocol/protocolFacade.js';
import type { PluginUiSchema } from './ui/publicContract.js';
import { COMPOSER_MEDIA_CONTENT_CAPABILITY_V1 as canonicalComposerMediaContentCapabilityV1, MAX_COMPOSER_CONTENT_INSPECT_BYTES_V1 as canonicalMaxComposerContentInspectBytesV1 } from '@happier-dev/protocol/runtime/input/composerContentV1';
export type {
    ComposerContentHandleV1,
    ComposerContentInspectRequestV1,
    ComposerContentInspectWireResultV1,
    ComposerContentMediaKindV1,
    ComposerContentMimeTypeV1,
    ComposerContentPickMediaRequestV1,
    ComposerMediaContentCapabilityV1,
    ComposerSessionMediaContentV1,
    ComposerStagedMediaContentV1,
} from '@happier-dev/protocol/plugins/ui/client';
import type {
    PluginComposerAttachmentDefinition,
    PluginComposerControlDefinition,
    PluginComposerReferenceDefinition,
    PluginComposerRegionDefinition,
} from './definePlugin.js';

/** The one negotiated operation required before media selection, staging, or submission. */
export const COMPOSER_MEDIA_CONTENT_CAPABILITY_V1 = canonicalComposerMediaContentCapabilityV1;
export const MAX_COMPOSER_CONTENT_INSPECT_BYTES_V1 = canonicalMaxComposerContentInspectBytesV1;

export type { ComposerContentInspectResultV1 } from './ui/publicContract.js';

export function defineComposerReference(
    definition: PluginComposerReferenceDefinition,
): PluginComposerReferenceDefinition {
    return definition;
}

export type ComposerValueSchema = PluginUiSchema<unknown> & Readonly<{ jsonSchema: PluginJsonSchema }>;

type ComposerSchemaValue<TSchema extends ComposerValueSchema> =
    Extract<ReturnType<TSchema['parse']>, JsonValue>;

type ComposerPreparedSchemaValue<
    TDraft extends JsonValue,
    TSchema extends ComposerValueSchema | undefined,
> = TSchema extends ComposerValueSchema
    ? ComposerSchemaValue<TSchema>
    : TDraft;

function defineComposerAttachmentImplementation<
    const TValueSchema extends ComposerValueSchema,
    const TPreparedSchema extends ComposerValueSchema | undefined = undefined,
>(
    definition: Readonly<
        Omit<
            PluginComposerAttachmentDefinition<
                ComposerSchemaValue<TValueSchema>,
                ComposerPreparedSchemaValue<ComposerSchemaValue<TValueSchema>, TPreparedSchema>
            >,
            'value' | 'preparedValue'
        >
        & Readonly<{
            value: TValueSchema;
            preparedValue?: TPreparedSchema;
        }>
    >,
): PluginComposerAttachmentDefinition<
    ComposerSchemaValue<TValueSchema>,
    ComposerPreparedSchemaValue<ComposerSchemaValue<TValueSchema>, TPreparedSchema>
> {
    // The author helper preserves the exact schema objects at runtime while its
    // public result projects their parsed JSON outputs into the Composer types.
    return definition as PluginComposerAttachmentDefinition<
        ComposerSchemaValue<TValueSchema>,
        ComposerPreparedSchemaValue<ComposerSchemaValue<TValueSchema>, TPreparedSchema>
    >;
}

export const defineComposerAttachment = defineComposerAttachmentImplementation as <
    const TValueSchema extends ComposerValueSchema,
    const TPreparedSchema extends ComposerValueSchema | undefined = undefined,
>(
    definition: Readonly<
        Omit<
            PluginComposerAttachmentDefinition<
                Extract<ReturnType<TValueSchema['parse']>, JsonValue>,
                TPreparedSchema extends ComposerValueSchema
                    ? Extract<ReturnType<TPreparedSchema['parse']>, JsonValue>
                    : Extract<ReturnType<TValueSchema['parse']>, JsonValue>
            >,
            'value' | 'preparedValue'
        >
        & Readonly<{
            value: TValueSchema;
            preparedValue?: TPreparedSchema;
        }>
    >,
) => PluginComposerAttachmentDefinition<
    Extract<ReturnType<TValueSchema['parse']>, JsonValue>,
    TPreparedSchema extends ComposerValueSchema
        ? Extract<ReturnType<TPreparedSchema['parse']>, JsonValue>
        : Extract<ReturnType<TValueSchema['parse']>, JsonValue>
>;

export function defineComposerControl(
    definition: PluginComposerControlDefinition,
): PluginComposerControlDefinition {
    return definition;
}

export function defineComposerRegion(
    definition: PluginComposerRegionDefinition,
): PluginComposerRegionDefinition {
    return definition;
}
