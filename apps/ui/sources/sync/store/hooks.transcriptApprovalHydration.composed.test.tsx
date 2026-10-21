import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { ApprovalRequestV2Schema, ARTIFACT_PLAIN_DATA_KEY_MARKER, buildApprovalRequestArtifactHeaderV1,
    encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import { serveSessionActionHome } from '@/dev/testkit/harness/sessionActionHome';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { ArtifactReadBatchInputV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';

vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

// Load the real Sync graph before timed test setup; only HTTP and device storage are replaced.
installDisconnectedServerSocketBoundary();
await import('@/sync/syncEngine');

afterEach(() => standardCleanup());

describe('transcript approval hydration', () => {
    it.each(['recover', 'retire', 'isolate'] as const)('owns overlapping demanded receipt retries without another navigation (%s)', async scenario => {
        installDisconnectedServerSocketBoundary();
        const approval = ApprovalRequestV2Schema.parse({ v: 2, status: 'executed', createdAtMs: 1, updatedAtMs: 2,
            createdBy: { surface: 'agent', sessionId: 's1' }, requestedSurface: 'agent', actionId: 'session.capabilities.set',
            actionArgs: { sessionId: 's1', kind: 'skill', id: 'skill-1', state: 'on' },
            summary: 'Change capabilities', decision: { kind: 'approve', decidedAtMs: 2 }, execution: { executedAtMs: 3, ok: true, result: {} },
            executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent', caller: { kind: 'host' },
                serverId: 'remote', sessionId: 's1', actionId: 'session.capabilities.set', requestId: 'request' } });
        const artifactId = '11111111-1111-4111-8111-111111111111';
        const artifactIds = [artifactId, '11111111-1111-4111-8111-111111111112', '11111111-1111-4111-8111-111111111113'];
        let reads = 0;
        const readsById = new Map<string, number>();
        let failedIds: readonly string[] = [];
        let allowRecovery = false;
        const home = await serveSessionActionHome({ homes: [{ key: 'session', serverUrl: `https://receipt-retry-${scenario}.test`,
            accountId: 'session-account', currentAccount: true }], route: request => {
            if (request.path === '/v1/artifacts' && request.method === 'GET') return Response.json([]);
            if (request.path !== '/v1/artifacts/read') return undefined;
            reads += 1;
            const requestedIds = ArtifactReadBatchInputV1Schema.parse(request.body).artifactIds;
            for (const id of requestedIds) readsById.set(id, (readsById.get(id) ?? 0) + 1);
            if (reads === 1 && scenario !== 'isolate') {
                failedIds = requestedIds;
                return Response.json({ error: 'artifact_content_unavailable' }, { status: 503 });
            }
            return Response.json({ items: requestedIds.map(id => scenario === 'isolate' && id === artifactId && !allowRecovery
                ? { artifactId: id, ok: false, error: 'artifact_content_unavailable', status: 500, retryable: true }
                : { artifactId: id, ok: true, recipientCensus: null, artifact: {
                id, ownerAccountId: 'session-account', access: 'owner', encryptionMode: 'plain',
                dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, publicAudience: 'none',
                header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(approval)),
                body: encodePlainArtifactStoredContent({ body: JSON.stringify(approval) }),
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 2,
            } }) });
        } });
        const disconnect = await home.restoreActiveConnection();
        try {
            const { sync } = await import('@/sync/sync');
            const { storage } = await import('@/sync/domains/state/storage');
            for (const id of artifactIds) storage.getState().deleteArtifact(id);
            const pending = sync.hydrateSessionApprovalArtifacts(home.serverId, artifactIds.slice(0, 2));
            const overlapping = sync.hydrateSessionApprovalArtifacts(home.serverId, artifactIds.slice(1));
            const settled = Promise.all([pending, overlapping]).then(() => undefined, (error: unknown) => error);
            if (scenario === 'retire') {
                await vi.waitFor(() => expect(failedIds.length).toBeGreaterThan(0));
                const readsAtRetirement = reads;
                const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
                retireActiveServerAccountScopeLifetime();
                await expect(settled).resolves.toBeUndefined();
                expect(reads).toBe(readsAtRetirement);
                expect(failedIds.map(id => storage.getState().artifacts[id]?.body)).toEqual(failedIds.map(() => undefined));
            } else {
                if (scenario === 'isolate') {
                    await overlapping;
                    expect(artifactIds.slice(1).map(id => storage.getState().artifacts[id]?.body)).toEqual([JSON.stringify(approval), JSON.stringify(approval)]);
                    expect(storage.getState().artifacts[artifactId]?.body).toBeUndefined();
                    expect(artifactIds.slice(1).map(id => readsById.get(id))).toEqual([1, 1]);
                    allowRecovery = true;
                }
                await Promise.all([pending, overlapping]);
                expect(artifactIds.map(id => readsById.get(id))).toEqual(artifactIds.map(id =>
                    scenario === 'isolate' ? id === artifactId ? 2 : 1 : failedIds.includes(id) ? 2 : 1));
                expect(artifactIds.map(id => storage.getState().artifacts[id]?.body)).toEqual(artifactIds.map(() => JSON.stringify(approval)));
            }
        } finally { await disconnect(); await home.dispose(); }
    });
    it.each(['already-settled', 'settled-during-read'] as const)('hydrates the exact-Home transcript without reopening its receipt (%s)', async scenario => {
        installDisconnectedServerSocketBoundary();
        const portableHome = 'srv_transcript_approval';
        const approval = ApprovalRequestV2Schema.parse({ v: 2, status: 'executed', createdAtMs: 1, updatedAtMs: 2,
            createdBy: { surface: 'agent', sessionId: 's1' }, requestedSurface: 'agent',
            actionId: 'session.capabilities.set', actionArgs: { sessionId: 's1', kind: 'skill', id: 'skill-1', state: 'on' },
            summary: 'Change session capabilities', decision: { kind: 'approve', decidedAtMs: 2 },
            execution: { executedAtMs: 3, ok: true, result: {} },
            executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent', caller: { kind: 'host' },
                serverId: 'remote-cli-profile', serverIdentityId: portableHome, sessionId: 's1',
                actionId: 'session.capabilities.set', requestId: 'request-1' } });
        const earlier = ApprovalRequestV2Schema.parse({ ...approval, status: 'open', updatedAtMs: 1,
            decision: undefined, execution: undefined });
        const responseApproval = scenario === 'settled-during-read' ? earlier : approval;
        const header = buildApprovalRequestArtifactHeaderV1(responseApproval);
        const settledHeader = buildApprovalRequestArtifactHeaderV1(approval);
        const artifactId = '11111111-1111-4111-8111-111111111111';
        const inventory = [
            { id: artifactId, header: settledHeader },
            { id: 'other', header: { ...settledHeader, serverIdentityId: 'srv_other_home' } },
        ].map(row => ({ ...row, ownerAccountId: 'session-account', access: 'owner', encryptionMode: 'plain',
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, publicAudience: 'none',
            header: encodePlainArtifactStoredContent(row.header),
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 2 }));
        const reads: unknown[] = [];
        const responseReady = createDeferred<void>();
        const home = await serveSessionActionHome({ homes: [{ key: 'session', serverUrl: 'https://transcript-approval.test',
            accountId: 'session-account', serverIdentityId: portableHome, currentAccount: true }], route: async request => {
            if (request.path === '/v1/artifacts' && request.method === 'GET') return Response.json(inventory);
            if (request.path !== '/v1/artifacts/read') return undefined;
            reads.push(request.body);
            await responseReady.promise;
            return Response.json({ items: [{ artifactId, ok: true, recipientCensus: null, artifact: {
                id: artifactId, ownerAccountId: 'session-account', access: 'owner', encryptionMode: 'plain',
                dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, publicAudience: 'none',
                header: encodePlainArtifactStoredContent(header), body: encodePlainArtifactStoredContent({ body: JSON.stringify(responseApproval) }),
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 2,
            } }] });
        } });
        const disconnect = await home.restoreActiveConnection();
        const { storage, useTranscriptApprovalArtifactsForSession, useOpenApprovalSessionReferences } = await import('@/sync/domains/state/storage');
        const presents = [() => true];
        try {
            await waitForHomeGovernance(() => {
                expect(storage.getState().isDataReady).toBe(true);
                expect(storage.getState().artifactsLoaded).toBe(true);
                expect(storage.getState().artifacts[artifactId]?.header).toEqual(settledHeader);
            });
            // Startup is settled before opening the held read window. Both the
            // authoritative inventory and the device now carry that window's headers.
            inventory[0]!.header = encodePlainArtifactStoredContent(header);
            inventory[1]!.header = encodePlainArtifactStoredContent({ ...header, serverIdentityId: 'srv_other_home' });
            storage.setState({ artifacts: {
                [artifactId]: { id: artifactId, header, rawHeader: header, title: header.title,
                    bodyVersion: 1, headerVersion: 1, seq: 1, createdAt: 1, updatedAt: 2, isDecrypted: true, storageMode: 'plain' },
                other: { id: 'other', header: { ...header, serverIdentityId: 'srv_other_home' },
                    bodyVersion: 1, headerVersion: 1, seq: 1, createdAt: 1, updatedAt: 2, isDecrypted: true, storageMode: 'plain' },
            } });
            const hook = await renderHook(() => ({
                approvals: useTranscriptApprovalArtifactsForSession({ serverId: home.serverId, sessionId: 's1' }, presents),
                open: useOpenApprovalSessionReferences(),
            }));
            const duplicate = await renderHook(() => useTranscriptApprovalArtifactsForSession({ serverId: home.serverId, sessionId: 's1' }, presents));
            await act(async () => { await vi.waitFor(() => expect(reads).toHaveLength(1)); });
            const { sync } = await import('@/sync/sync');
            const inFlight = sync.hydrateSessionApprovalArtifacts(home.serverId, [artifactId]);
            if (scenario === 'settled-during-read') {
                const { handleUpdateArtifactSocketUpdate } = await import('@/sync/engine/artifacts/syncArtifacts');
                await act(async () => { await handleUpdateArtifactSocketUpdate({ artifactId, createdAt: 3,
                    header: { version: 2, value: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(approval)) },
                    body: { version: 2, value: encodePlainArtifactStoredContent({ body: JSON.stringify(approval) }) },
                    artifactDataKeys: new Map(), getExistingArtifact: id => storage.getState().artifacts[id],
                    updateArtifact: row => storage.getState().updateArtifact(row),
                    invalidateArtifactsSync: () => { throw new Error('Readable settlement must not need a refresh'); },
                    log: { log: () => {} },
                }); });
            }
            await act(async () => { responseReady.resolve(); await inFlight; });
            await act(async () => { await vi.waitFor(() => expect(hook.getCurrent().approvals).toHaveLength(1)); });
            expect(hook.getCurrent().approvals[0]?.approval.status).toBe('executed');
            expect(hook.getCurrent().open).toEqual(scenario === 'settled-during-read'
                ? [{ kind: 'exact', address: { serverId: 'srv_other_home', sessionId: 's1' } }] : []);
            expect(duplicate.getCurrent()[0]?.approval.status).toBe('executed');
            expect(reads).toEqual([{ artifactIds: [artifactId] }]);
            await duplicate.unmount();
            await hook.unmount();
            const remount = await renderHook(() => useTranscriptApprovalArtifactsForSession({ serverId: home.serverId, sessionId: 's1' }, presents));
            expect(remount.getCurrent()).toHaveLength(1);
            expect(reads).toHaveLength(1);
            await remount.unmount();
        } finally { responseReady.resolve(); await disconnect(); await home.dispose(); }
    });
});
