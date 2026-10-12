import { describe, expect, it } from 'vitest';
import * as protocol from '../index.js';

describe('Channels V1 Session last-delivery presentation', () => {
    it('validates the bounded sibling list without accepting custody or content authority', () => {
        const deliveries = [{ bindingId: 'binding-1', atMs: 300, outcome: 'delivered' }];
        expect(protocol.ConversationSessionLastDeliveriesV1Schema.parse(deliveries)).toEqual(deliveries);
        expect(protocol.ConversationSessionLastDeliveriesV1Schema.safeParse([
            { ...deliveries[0], outcome: 'partial' },
        ]).success).toBe(false);
        expect(protocol.ConversationSessionLastDeliveriesV1Schema.safeParse([
            { ...deliveries[0], atMs: -1 },
        ]).success).toBe(false);
        expect(protocol.ConversationSessionLastDeliveriesV1Schema.safeParse([
            { ...deliveries[0], content: 'private' },
        ]).success).toBe(false);
        expect(protocol.ConversationSessionLastDeliveriesV1Schema.safeParse(
            Array.from({ length: 256 + 1 }, () => deliveries[0]),
        ).success).toBe(true);
    });
});
