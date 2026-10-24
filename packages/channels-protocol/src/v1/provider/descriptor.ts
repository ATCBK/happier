import {
    defineProtocolLiteral,
    defineProtocolObject,
    defineProtocolString,
} from '@happier-dev/plugin-sdk/protocol';
import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

/** Provider presentation, independent of the contributing plugin's brand. */
export const ConversationProviderDescriptorV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    displayName: defineProtocolString({ minLength: 1, pattern: '\\S' }),
}, { policy: 'additive-open/drop' });
export type ConversationProviderDescriptorV1 = ReturnType<typeof ConversationProviderDescriptorV1Schema.parse>;
export const ConversationProviderDescriptorV1JsonSchema: PluginJsonSchema = ConversationProviderDescriptorV1Schema.jsonSchema;
