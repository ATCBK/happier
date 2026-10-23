import { describe, expect, it } from 'vitest';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/plugin-sdk/manifest';
import { ConversationDeliveryAttentionResultV1Schema, ConversationIngressAttentionResultV1Schema } from './reads.js';

describe('Channels ingress attention privacy contract', () => {
    const terminal = {
        kind: 'terminal', obligationId: 'a'.repeat(43), revision: 1,
        connectionId: 'connection-1', bindingId: 'binding-1', updatedAt: 1,
        category: 'informational',
    };

    it('accepts content-free drop reasons and older reasonless terminal projections', () => {
        const schema = compilePluginJsonSchema(ConversationIngressAttentionResultV1Schema.jsonSchema);
        for (const reason of [undefined, 'actorUnattributable', 'actorNotAllowed', 'botSenderDisabled']) {
            const result = { obligations: [{ ...terminal, ...(reason === undefined ? {} : { reason }) }] };
            expect(ConversationIngressAttentionResultV1Schema.parse(result)).toEqual(result);
            expect(isValidPluginJsonSchemaValue(schema, result)).toBe(true);
        }
    });

    it('rejects arbitrary reason text and message or sender evidence', () => {
        const schema = compilePluginJsonSchema(ConversationIngressAttentionResultV1Schema.jsonSchema);
        for (const extra of [
            { reason: 'private message text' },
            { reason: 'actorNotAllowed', principalId: 'private@example.test' },
            { reason: 'botSenderDisabled', messageId: 'private-message' },
        ]) {
            const result = { obligations: [{ ...terminal, ...extra }] };
            expect(() => ConversationIngressAttentionResultV1Schema.parse(result)).toThrow();
            expect(isValidPluginJsonSchemaValue(schema, result)).toBe(false);
        }
    });
});

describe('Channels delivery attention conversation identity', () => {
    const row = { custodyId: 'd'.repeat(43), revision: 1, createdAt: 1_000, state: 'outcomeUnknown', acceptedPartCount: 0 };

    it('reads the owning binding and keeps connection-only custody unbound', () => {
        const schema = compilePluginJsonSchema(ConversationDeliveryAttentionResultV1Schema.jsonSchema);
        for (const identity of [{ bindingId: 'binding-external-1' }, {}]) {
            const result = { rows: [{ ...row, ...identity }] };
            expect(ConversationDeliveryAttentionResultV1Schema.parse(result)).toEqual(result);
            expect(isValidPluginJsonSchemaValue(schema, result)).toBe(true);
        }
    });

    it('rejects malformed binding identity and private delivery evidence', () => {
        const schema = compilePluginJsonSchema(ConversationDeliveryAttentionResultV1Schema.jsonSchema);
        for (const extra of [
            { bindingId: '' }, { bindingId: null }, { bindingId: 1 }, { bindingId: 'binding with spaces' },
            { bindingId: 'binding-1', content: { text: 'private-body' } },
            { bindingId: 'binding-1', providerMessageIds: ['private-native-id'] },
            { bindingId: 'binding-1', endpoint: { id: 'private-endpoint' } },
        ]) {
            const result = { rows: [{ ...row, ...extra }] };
            expect(() => ConversationDeliveryAttentionResultV1Schema.parse(result)).toThrow();
            expect(isValidPluginJsonSchemaValue(schema, result)).toBe(false);
        }
    });
});
