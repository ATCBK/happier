import { expect, it } from 'vitest';

import { encodeBase64 } from '@/encryption/base64';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { Encryption } from '@/sync/encryption/encryption';
import { storage } from '@/sync/domains/state/storage';
import { buildTrustedHostSessionInputAdmissionV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';

it.each(['read', 'discard', 'block', 'restore', 'deleteDiscarded', 'reorder'] as const)(
    'opens queued plugin input with its captured Home reader after %s', async operation => {
    const sessionId = 'pending-owner-home';
    const localId = 'plugin-input-v1:pending-owner-home';
    const ownerSecret = new Uint8Array(32).fill(23);
    const encryption = await Encryption.create(ownerSecret);
    await encryption.initializeSessions(new Map([[sessionId, null]]));
    const reader = encryption.getSessionEncryption(sessionId);
    if (!reader) throw new Error('Fixture Session reader unavailable');
    const admission = buildTrustedHostSessionInputAdmissionV1('cli');
    const ciphertext = await reader.encryptRawRecord({
        role: 'user', content: { type: 'text', text: 'queued on the owning Home' },
        meta: { sentFrom: 'cli', source: 'ui', happierProvenanceV1: admission.provenance,
            happierInputRequestV1: admission.request },
    });
    const survivorId = localId + '-survivor';
    const startsDiscarded = operation === 'restore' || operation === 'deleteDiscarded';
    let rows = [localId, survivorId].map((id, position) => ({
        localId: id, content: { t: 'encrypted', c: ciphertext }, messageRole: 'user', status: 'queued',
        requestedAction: { v: 1, kind: 'send_now' }, position, createdAt: 1, updatedAt: 1,
        discardedAt: null as number | null, discardedReason: null as string | null,
        deliveryState: null as string | null, deliveryBlockedReason: null as string | null,
        ...(startsDiscarded && id === localId ? { status: 'discarded', discardedAt: 2, discardedReason: 'manual' } : {}),
    }));
    const homes = await serveActionHomes({
        homes: [
            { key: 'owner', serverUrl: 'https://pending-owner.test', accountId: 'pending-owner', accountMode: 'e2ee',
                credentials: { token: 'header.' + Buffer.from(JSON.stringify({ sub: 'pending-owner' })).toString('base64url') + '.signature',
                    secret: encodeBase64(ownerSecret) } },
            { key: 'active', serverUrl: 'https://pending-active.test', accountId: 'pending-active' },
        ],
        route: request => {
            if (request.path === '/v1/features') return Response.json({
                features: {},
                capabilities: { session: { runtimeActivity: { protocolVersion: 2 }, pendingInput: { protocolVersion: 1 } } },
            });
            if (request.home !== 'owner') return undefined;
            if (request.path === `/v2/sessions/${sessionId}`) return Response.json({ session: {
                id: sessionId, seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1, archivedAt: null,
                metadata: 'unused', metadataVersion: 1, agentState: null, agentStateVersion: 0,
                encryptionMode: 'e2ee', dataEncryptionKey: null, pendingCount: 1, pendingVersion: 1,
            } });
            const pendingPath = `/v2/sessions/${sessionId}/pending`;
            if (request.path === pendingPath && request.method === 'GET') return Response.json({ pending: rows });
            if (request.path.startsWith(pendingPath + '/') && request.method !== 'GET') {
                rows = rows.flatMap(row => {
                    if (row.localId !== localId) return [row];
                    if (request.method === 'DELETE') return [];
                    if (request.path.endsWith('/discard')) return [{ ...row, status: 'discarded', discardedAt: 2, discardedReason: 'manual' }];
                    if (request.path.endsWith('/restore')) return [{ ...row, status: 'queued', discardedAt: null, discardedReason: null }];
                    if (request.path.endsWith('/delivery/block')) return [{ ...row, deliveryState: 'blocked', deliveryBlockedReason: 'runtime_config_blocked' }];
                    return [row];
                });
                return Response.json({});
            }
            return undefined;
        },
    });
    try {
        const owner = homes.homes.owner!;
        storage.getState().applyServerScopedSessionListRows(owner.id, [createSessionFixture({
            id: sessionId, serverId: owner.id, encryptionMode: 'e2ee', pendingCount: 1, pendingVersion: 1,
        })], { source: 'ordinary', mode: 'replace' });
        const { sync } = await import('./sync');
        await sync.fetchPendingMessages(sessionId);
        const options = { serverId: owner.id };
        if (operation === 'discard') await sync.discardPendingMessage(sessionId, localId, options);
        if (operation === 'block') await sync.blockPendingDelivery(sessionId, localId, 'runtime_config_blocked', options);
        if (operation === 'restore') await sync.restoreDiscardedPendingMessage(sessionId, localId, options);
        if (operation === 'deleteDiscarded') await sync.deleteDiscardedPendingMessage(sessionId, localId, options);
        if (operation === 'reorder') await sync.reorderPendingMessages(sessionId, [survivorId, localId], undefined, options);
        const survivor = storage.getState().sessionPending[sessionId]?.messages.find(message => message.localId === survivorId);
        expect(survivor).toMatchObject({ localId: survivorId, text: 'queued on the owning Home', pendingDeliveryStatus: 'server_queued' });
        expect(survivor?.pendingDecryptFailure).toBeUndefined();
    } finally {
        await homes.dispose();
    }
}, 120000);
