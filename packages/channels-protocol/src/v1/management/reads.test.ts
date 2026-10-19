import { describe, expect, it } from 'vitest';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/plugin-sdk/manifest';
import { ConversationIngressAttentionResultV1Schema } from './reads.js';

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
