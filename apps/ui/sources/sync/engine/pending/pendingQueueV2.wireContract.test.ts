import { describe, expect, it } from 'vitest';

import {
    isReleasedServerV021PendingEnqueueResponse,
    serializePendingEnqueueBodyForServerWire,
} from './pendingQueueV2';

const canonicalBody = JSON.stringify({
    localId: 'local-1',
    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
    messageRole: 'user',
    requestedAction: { v: 1, kind: 'send_now' },
    deliveryMode: 'external_handoff',
});

describe('Pending queue server-wire serialization', () => {
    it('publishes the unchanged informational-note operand only on the current V5 wire', () => {
        const body = JSON.stringify({ localId: 'review-note', nextTurnNote: 'file_review_note.v1',
            content: { t: 'plain', v: { role: 'user' } }, requestedAction: { v: 1, kind: 'enqueue' } });
        expect(serializePendingEnqueueBodyForServerWire(body, 'pending_input_v5')).toBe(body);
    });
    it.each(['pending_input_v1', 'pending_input_v3', 'pending_input_v4', 'released_server_v0_2_1', 'indeterminate'] as const)(
        'never publishes a next-turn review note without V5 support (%s)', mode => {
            const body = JSON.stringify({ localId: 'review-note', nextTurnNote: 'file_review_note.v1',
                content: { t: 'plain', v: { role: 'user' } }, requestedAction: { v: 1, kind: 'enqueue' } });
            expect(() => serializePendingEnqueueBodyForServerWire(body, mode)).toThrow(
                expect.objectContaining({ code: 'server-upgrade-required' }));
        });
    it('keeps direct fresh released-server downgrade admission strict', () => {
        const body = JSON.stringify({ localId: 'fresh-action',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
            requestedAction: { v: 1, kind: 'enqueue', retired: true },
        });
        expect(serializePendingEnqueueBodyForServerWire(body, 'released_server_v0_2_1')).toBeNull();
    });
    it('preserves a frozen reset on V4 and refuses every earlier or unknown wire', () => {
        const body = JSON.stringify({
            localId: 'reset-local', messageRole: 'user',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'held prompt' } } },
            requestedAction: { v: 1, kind: 'reset_start', reset: {
                source: { bindingKind: 'account', ref: { service: { pluginId: 'happier.agent.codex', localId: 'codex-account' }, accountId: 'connected-account' } },
                recordId: 'paug_v1_receipt1', meterId: 'requests', witness: { id: 'accepted-history-row', observedAtMs: 100 },
            } },
        });
        expect(serializePendingEnqueueBodyForServerWire(body, 'pending_input_v4')).toBe(body);
        expect(serializePendingEnqueueBodyForServerWire(body, 'pending_input_v5')).toBe(body);
        for (const mode of ['pending_input_v1', 'pending_input_v3', 'released_server_v0_2_1', 'indeterminate'] as const) {
            expect(() => serializePendingEnqueueBodyForServerWire(body, mode))
                .toThrow(expect.objectContaining({ code: 'server-upgrade-required' }));
        }
    });
    it('preserves the full canonical body for Pending-input v1', () => {
        expect(serializePendingEnqueueBodyForServerWire(canonicalBody, 'pending_input_v1')).toBe(canonicalBody);
    });

    it('keeps resume authorization separate on the current wire and strips it for v1 replay', () => {
        const body = JSON.stringify({
            localId: 'local-resume',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
            messageRole: 'user',
            requestedAction: { v: 1, kind: 'enqueue' },
            resumeWhenAvailable: true,
        });

        expect(serializePendingEnqueueBodyForServerWire(body, 'pending_input_v3')).toBe(body);
        expect(JSON.parse(serializePendingEnqueueBodyForServerWire(body, 'pending_input_v1')!)).toEqual({
            localId: 'local-resume',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
            messageRole: 'user',
            requestedAction: { v: 1, kind: 'enqueue' },
        });
    });

    it.each([
        [JSON.stringify({
            localId: 'local-1',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
            messageRole: 'user',
            requestedAction: { v: 1, kind: 'enqueue' },
        }), {
            localId: 'local-1',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
        }],
        [JSON.stringify({
            localId: 'local-2', ciphertext: 'ciphertext', messageRole: 'user',
            requestedAction: { v: 1, kind: 'enqueue' },
        }), { localId: 'local-2', ciphertext: 'ciphertext' }],
    ])('serializes only the released-server envelope %#', (body, expected) => {
        const serialized = serializePendingEnqueueBodyForServerWire(body, 'released_server_v0_2_1');
        expect(serialized && JSON.parse(serialized)).toEqual(expected);
    });

    it('preserves surrounding whitespace in an accepted opaque localId', () => {
        const body = JSON.stringify({
            localId: ' opaque-local ',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
            requestedAction: { v: 1, kind: 'enqueue' },
        });
        const serialized = serializePendingEnqueueBodyForServerWire(body, 'released_server_v0_2_1');
        expect(serialized && JSON.parse(serialized)).toMatchObject({ localId: ' opaque-local ' });
    });

    it.each([
        ['indeterminate' as const, canonicalBody],
        ['released_server_v0_2_1' as const, JSON.stringify({
            localId: 'local-1',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
            requestedAction: null,
        })],
        ['released_server_v0_2_1' as const, JSON.stringify({ localId: 'local-1' })],
        ['released_server_v0_2_1' as const, JSON.stringify({
            localId: '   ',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
            requestedAction: { v: 1, kind: 'enqueue' },
        })],
        ['released_server_v0_2_1' as const, 'not-json'],
    ])('fails closed for %s with an unsupported canonical body', (mode, body) => {
        expect(serializePendingEnqueueBodyForServerWire(body, mode)).toBeNull();
    });

    it.each([
        canonicalBody,
        JSON.stringify({
            localId: 'local-1',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
            requestedAction: { v: 1, kind: 'send_now' },
        }),
        JSON.stringify({
            localId: 'local-1',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
            requestedAction: { v: 1, kind: 'enqueue' },
            deliveryMode: 'external_handoff',
        }),
    ])('rejects a final-only action with an explicit upgrade-required contract', (body) => {
        expect(() => serializePendingEnqueueBodyForServerWire(
            body,
            'released_server_v0_2_1',
        )).toThrow(expect.objectContaining({ code: 'server-upgrade-required' }));
    });
});

const releasedServerAck = {
    didWrite: true,
    pending: {
        localId: 'local-1',
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
        status: 'queued',
        position: 1,
        createdAt: 1_000,
        updatedAt: 1_001,
        discardedAt: null,
        discardedReason: null,
        authorAccountId: 'account-1',
    },
    pendingCount: 1,
    pendingVersion: 2,
};

describe('released server v0.2.1 Pending enqueue response parsing', () => {
    it('accepts the immutable released-server response shape for the exact local id', () => {
        expect(isReleasedServerV021PendingEnqueueResponse(releasedServerAck, 'local-1')).toBe(true);
        expect(isReleasedServerV021PendingEnqueueResponse({ ...releasedServerAck, didWrite: false }, 'local-1')).toBe(true);
    });

    it.each([
        null,
        { ...releasedServerAck, didWrite: 'true' },
        { ...releasedServerAck, unexpected: true },
        { ...releasedServerAck, pending: { ...releasedServerAck.pending, localId: 'other-local' } },
        { ...releasedServerAck, pending: { ...releasedServerAck.pending, unexpected: true } },
        { ...releasedServerAck, pending: { ...releasedServerAck.pending, content: null } },
        { ...releasedServerAck, pending: { ...releasedServerAck.pending, status: 'delivering' } },
        { ...releasedServerAck, pending: { ...releasedServerAck.pending, authorAccountId: null } },
        { ...releasedServerAck, pendingCount: -1 },
        { ...releasedServerAck, pendingVersion: 1.5 },
    ])('rejects a non-released or mismatched acknowledgement %#', (payload) => {
        expect(isReleasedServerV021PendingEnqueueResponse(payload, 'local-1')).toBe(false);
    });
});
