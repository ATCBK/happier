import { defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';

const text = defineProtocolString({ minLength: 1 });
const closed = { policy: 'closed' } as const;
export const sampleCardSchema = defineProtocolObject({ id: text, title: text }, closed);
export const inspectedItemSchema = defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('session'),
        address: defineProtocolObject({ serverId: text, sessionId: text }, closed) }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('sample'), reference: sampleCardSchema }, closed),
]);
