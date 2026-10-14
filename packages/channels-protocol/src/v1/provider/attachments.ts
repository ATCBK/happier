import {
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolString,
    defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';

import { ConversationProviderFailureV1ProtocolSchema } from '../diagnostics.js';
import { ConversationProviderConnectionInputV1Fields } from './connection.js';

/** Provider-local immutable file identity; observations never carry file bytes or paths. */
export const ConversationMessageAttachmentV1Schema = defineProtocolObject({
    attachmentId: defineProtocolString({ minLength: 1 }),
    name: defineProtocolString({ minLength: 1 }),
    mediaType: defineProtocolString({ minLength: 1 }),
    byteLength: defineProtocolNumber({ integer: true, minimum: 0, maximum: Number.MAX_SAFE_INTEGER }).optional(),
}, { policy: 'closed' });
export type ConversationMessageAttachmentV1 = ReturnType<typeof ConversationMessageAttachmentV1Schema.parse>;
export const ConversationMessageAttachmentV1JsonSchema = ConversationMessageAttachmentV1Schema.jsonSchema;

/** One consuming operation fetches its referenced files from one admitted message. */
export const ConversationAttachmentFetchInputV1Schema = defineProtocolObject({
    ...ConversationProviderConnectionInputV1Fields,
    messageId: defineProtocolString({ minLength: 1 }),
    attachmentIds: defineProtocolArray(defineProtocolString({ minLength: 1 }), { minItems: 1 }),
}, { policy: 'closed' });
export type ConversationAttachmentFetchInputV1 = ReturnType<typeof ConversationAttachmentFetchInputV1Schema.parse>;
export const ConversationAttachmentFetchInputV1JsonSchema = ConversationAttachmentFetchInputV1Schema.jsonSchema;

/** Live bytes only: the consumer owns temporary files until Session transfer completes. */
export const ConversationAttachmentFetchResultV1Schema = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolLiteral('fetched'),
        attachments: defineProtocolArray(defineProtocolObject({
            attachmentId: defineProtocolString({ minLength: 1 }),
            base64: defineProtocolString(),
        }, { policy: 'closed' })),
    }, { policy: 'closed' }),
    ConversationProviderFailureV1ProtocolSchema,
]);
export type ConversationAttachmentFetchResultV1 = ReturnType<typeof ConversationAttachmentFetchResultV1Schema.parse>;
export const ConversationAttachmentFetchResultV1JsonSchema = ConversationAttachmentFetchResultV1Schema.jsonSchema;
