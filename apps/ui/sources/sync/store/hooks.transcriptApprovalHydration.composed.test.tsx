import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { Platform } from 'react-native';
import { ApprovalRequestV2Schema, ARTIFACT_PLAIN_DATA_KEY_MARKER, buildApprovalRequestArtifactHeaderV1,
    encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import { serveSessionActionHome } from '@/dev/testkit/harness/sessionActionHome';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { ArtifactReadBatchInputV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { fetchArtifactReadBatch } from '@/sync/api/artifacts/apiArtifacts';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { encodeBase64 } from '@/encryption/base64';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';

vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

// Load the real Sync graph before timed test setup; only HTTP and device storage are replaced.
installDisconnectedServerSocketBoundary();
await import('@/sync/syncEngine');

afterEach(() => standardCleanup());

describe('transcript approval hydration', () => {
    it('recovers an absent cold transcript approval through the inventory retry owner without visiting Inbox', async () => {
        const portableHome = 'srv_cold_approval_retry';
        const approval = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent', sessionId: 's1' }, requestedSurface: 'agent',
            actionId: 'session.capabilities.set', actionArgs: { sessionId: 's1', kind: 'skill', id: 'skill-1', state: 'on' },
            summary: 'Change session capabilities',
            executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent', caller: { kind: 'host' },
                serverId: 'remote-cli-profile', serverIdentityId: portableHome, sessionId: 's1',
                actionId: 'session.capabilities.set', requestId: 'cold-request' } });
        const artifactId = '11111111-1111-4111-8111-111111111171';
        const artifact = { id: artifactId, ownerAccountId: 'session-account', access: 'owner', encryptionMode: 'plain',
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, publicAudience: 'none', kind: 'other',
            header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(approval)),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(approval) }),
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        const failed = createDeferred<void>();
        const retry = createDeferred<void>();
        let listReads = 0;
        const bodyReads: string[][] = [];
        const home = await serveSessionActionHome({ homes: [{ key: 'session', serverUrl: 'https://cold-approval-retry.test',
            accountId: 'session-account', serverIdentityId: portableHome, currentAccount: true }], route: async request => {
            if (request.path === '/v1/artifacts' && request.method === 'GET') {
                if (++listReads === 1) {
                    failed.resolve();
                    return Response.json({ error: 'artifact_list_failed' }, { status: 500 });
                }
                await retry.promise;
                const { body: _body, ...header } = artifact;
                return Response.json([header]);
            }
            if (request.path !== '/v1/artifacts/read') return undefined;
            const { artifactIds } = ArtifactReadBatchInputV1Schema.parse(request.body);
            bodyReads.push(artifactIds);
            return Response.json({ items: artifactIds.map(id => ({ artifactId: id, ok: true, recipientCensus: null, artifact })) });
        } });
        const disconnect = await home.restoreActiveConnection();
        try {
            const { storage, useTranscriptApprovalArtifactsForSession } = await import('@/sync/domains/state/storage');
            await failed.promise;
            expect(storage.getState().artifacts[artifactId]).toBeUndefined();
            expect(storage.getState().artifactsLoaded).toBe(false);
            const presentations = [() => true];
            const hook = await renderHook(() => useTranscriptApprovalArtifactsForSession({ serverId: home.serverId, sessionId: 's1' }, presentations));
            try {
                expect(hook.getCurrent()).toHaveLength(0);
                await act(async () => {
                    retry.resolve();
                    await waitForHomeGovernance(() => expect(hook.getCurrent()).toHaveLength(1));
                });
                expect(hook.getCurrent()[0]?.approval.status).toBe('open');
                expect(storage.getState().artifactsLoaded).toBe(true);
                expect(listReads).toBe(2);
                expect(bodyReads).toEqual([[artifactId]]);
            } finally { await hook.unmount(); }
        } finally { retry.resolve(); await disconnect(); await home.dispose(); }
    });

    it.each(['ios', 'web'] as const)('batches an Inbox hydration request after real E2EE Account authority acquisition (%s)', async platform => {
        const previousPlatform = Object.getOwnPropertyDescriptor(Platform, 'OS')!;
        const webStorage = platform === 'web' ? installLocalStorageMock() : null;
        Object.defineProperty(Platform, 'OS', { ...previousPlatform, value: platform });
        try {
            const artifactIds = Array.from({ length: 32 }, (_, index) => `11111111-1111-4111-8111-${String(index + 201).padStart(12, '0')}`);
            const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'encrypted-reader', tokenEpoch: 0,
                provenance: { v: 1, kind: 'account', authority: 'present_user' } })), 'base64url')}.signature`;
            const detailRequests: string[][] = [];
            const home = await serveSessionActionHome({ homes: [{ key: 'session', serverUrl: 'https://receipt-encrypted-reader.test',
                accountId: 'encrypted-reader', accountMode: 'e2ee',
                credentials: { token, secret: encodeBase64(new Uint8Array(32).fill(47), 'base64url') } }], route: request => {
                if (request.path === '/v1/artifacts' && request.method === 'GET') return Response.json([]);
                if (request.path !== '/v1/artifacts/read') return undefined;
                const { artifactIds: selected } = ArtifactReadBatchInputV1Schema.parse(request.body);
                detailRequests.push(selected);
                // A keyholding E2EE reader can receive a plain owner's shared Artifact;
                // the real authority path still derives the reader's Account encryption.
                return Response.json({ items: selected.map(id => ({ artifactId: id, ok: true, recipientCensus: null,
                    artifact: { id, ownerAccountId: 'plain-owner', access: 'view', encryptionMode: 'plain',
                        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, publicAudience: 'none',
                        header: encodePlainArtifactStoredContent({ kind: 'approval_request.v1', title: 'Receipt' }),
                        body: encodePlainArtifactStoredContent({ body: `receipt-${id}` }),
                        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } })) });
            } });
            const disconnect = await home.restoreActiveConnection();
            try {
                const { sync } = await import('@/sync/sync');
                const { storage } = await import('@/sync/domains/state/storage');
                await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
                await sync.hydrateSessionApprovalArtifacts(home.serverId, artifactIds);
                expect(artifactIds.map(id => storage.getState().artifacts[id]?.body)).toEqual(artifactIds.map(id => `receipt-${id}`));
                expect({ requests: detailRequests.length, batchSizes: detailRequests.map(ids => ids.length) })
                    .toEqual({ requests: 1, batchSizes: [artifactIds.length] });
                expect(detailRequests[0]).toEqual(artifactIds);
                await sync.hydrateSessionApprovalArtifacts(home.serverId, artifactIds);
                expect(detailRequests).toHaveLength(1);
            } finally { await disconnect(); await home.dispose(); }
        } finally {
            Object.defineProperty(Platform, 'OS', previousPlatform);
            webStorage?.restore();
        }
    });

    it('publishes concurrent transcript body completions together through the real Sync writer', async () => {
        const artifactIds = Array.from({ length: 6 }, (_, index) => `11111111-1111-4111-8111-${String(index + 101).padStart(12, '0')}`);
        const detailRequests: string[][] = [];
        const home = await serveSessionActionHome({ homes: [{ key: 'session', serverUrl: 'https://receipt-publication.test',
            accountId: 'session-account', currentAccount: true }], route: request => {
            if (request.path === '/v1/artifacts' && request.method === 'GET') return Response.json([]);
            if (request.path !== '/v1/artifacts/read') return undefined;
            const { artifactIds: selected } = ArtifactReadBatchInputV1Schema.parse(request.body);
            detailRequests.push(selected);
            return Response.json({ items: selected.map(id => ({ artifactId: id, ok: true, recipientCensus: null,
                artifact: { id, ownerAccountId: 'session-account', access: 'owner', encryptionMode: 'plain',
                    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, publicAudience: 'none',
                    header: encodePlainArtifactStoredContent({ kind: 'approval_request.v1', title: 'Settled receipt' }),
                    body: encodePlainArtifactStoredContent({ body: `receipt-${id}` }),
                    headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } })) });
        } });
        const disconnect = await home.restoreActiveConnection();
        let off: (() => void) | undefined;
        try {
            const { sync } = await import('@/sync/sync');
            const { storage } = await import('@/sync/domains/state/storage');
            await waitForHomeGovernance(() => {
                expect(storage.getState().isDataReady).toBe(true);
                expect(storage.getState().artifactsLoaded).toBe(true);
            });
            let publications = 0;
            off = storage.subscribe((next, before) => {
                if (artifactIds.some(id => next.artifacts[id] !== before.artifacts[id])) publications++;
            });
            await Promise.all(artifactIds.map(id => sync.hydrateSessionApprovalArtifacts(home.serverId, [id])));
            expect(artifactIds.map(id => storage.getState().artifacts[id]?.body)).toEqual(artifactIds.map(id => `receipt-${id}`));
            expect(publications).toBe(1);
            expect(detailRequests).toEqual([artifactIds]);
        } finally { off?.(); await disconnect(); await home.dispose(); }
    });

    it('separates a prepared peer read from the inventory kind-backfill acknowledgement', async () => {
        const artifactId = '11111111-1111-4111-8111-111111111114';
        const held = createDeferred<void>();
        const release = createDeferred<void>();
        const backfilled = createDeferred<void>();
        let changed = false;
        let kind: 'prompt' | null = null;
        let reads = 0;
        const row = () => ({ id: artifactId, kind, ownerAccountId: 'session-account', access: 'owner', encryptionMode: 'plain',
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, publicAudience: 'none',
            header: encodePlainArtifactStoredContent({ title: 'Prompt', kind: 'prompt_doc.v2' }),
            body: encodePlainArtifactStoredContent({ body: 'Current' }), headerVersion: 1, bodyVersion: 1,
            seq: 1, createdAt: 1, updatedAt: 1 });
        const home = await serveSessionActionHome({ homes: [{ key: 'session', serverUrl: 'https://inventory-backfill-peer.test',
            accountId: 'session-account', currentAccount: true }], route: async request => {
            if (request.path === '/v1/artifacts' && request.method === 'GET') return Response.json(changed ? [row()] : []);
            if (request.path === '/v2/cursor') return Response.json({ cursor: changed ? 1 : 0, changesFloor: 0 });
            if (request.path === '/v2/changes') return Response.json({ changes: changed
                ? [{ kind: 'artifact', entityId: artifactId, cursor: 1, changedAt: 1, hint: null }] : [], nextCursor: changed ? 1 : 0 });
            if (request.path === `/v1/artifacts/${artifactId}` && request.method === 'POST') {
                expect(request.body).toEqual({ kind: 'prompt', expectedHeaderVersion: 1 });
                kind = 'prompt';
                backfilled.resolve();
                return Response.json({ success: true });
            }
            if (request.path !== '/v1/artifacts/read') return undefined;
            const ids = ArtifactReadBatchInputV1Schema.parse(request.body).artifactIds;
            const observed = row();
            reads++;
            if (reads === 1) { held.resolve(); await release.promise; }
            return Response.json({ items: ids.map(id => ({ artifactId: id, ok: true, artifact: observed, recipientCensus: null })) });
        } });
        const disconnect = await home.restoreActiveConnection();
        let old: ReturnType<typeof fetchArtifactReadBatch> | undefined;
        let current: ReturnType<typeof fetchArtifactReadBatch> | undefined;
        try {
            const { sync } = await import('@/sync/sync');
            const { storage } = await import('@/sync/domains/state/storage');
            await waitForHomeGovernance(() => {
                expect(storage.getState().isDataReady).toBe(true);
                expect(storage.getState().artifactsLoaded).toBe(true);
            });
            const credentials = sync.getCredentials();
            if (!credentials) throw new Error('Expected restored Account credentials');
            const active = getActiveServerSnapshot();
            const readTransport = apiSocket.createReadTransportForActiveServer({ ...active, endpoint: active.serverUrl });
            if (!readTransport) throw new Error('Expected actual prepared Account transport');
            old = fetchArtifactReadBatch(credentials, [artifactId], { readTransport });
            await held.promise;
            changed = true;
            await sync.fetchArtifactsList();
            await backfilled.promise;
            const readsBeforeAcknowledgedDemand = reads;
            current = fetchArtifactReadBatch(credentials, [artifactId], { readTransport });
            await vi.waitFor(() => expect(reads).toBe(readsBeforeAcknowledgedDemand + 1));
            await expect(current).resolves.toMatchObject([{ ok: true, artifact: { kind: 'prompt' } }]);
        } finally {
            release.resolve();
            await Promise.allSettled([old, current]);
            await disconnect(); await home.dispose();
        }
    });

    it.each(['recover', 'retire', 'isolate', 'refuse'] as const)('owns overlapping demanded receipt retries without another navigation (%s)', async scenario => {
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
            if (reads === 1 && (scenario === 'recover' || scenario === 'retire')) {
                failedIds = requestedIds;
                return Response.json({ error: 'artifact_content_unavailable' }, { status: 503 });
            }
            return Response.json({ items: requestedIds.map(id => id === artifactId
                && (scenario === 'refuse' || scenario === 'isolate' && !allowRecovery)
                ? { artifactId: id, ok: false, error: 'artifact_content_unavailable', status: 500, retryable: scenario !== 'refuse' }
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
            } else if (scenario === 'refuse') {
                await expect(pending).rejects.toMatchObject({ code: 'artifact_content_unavailable' });
                await expect(overlapping).resolves.toBeUndefined();
                expect(artifactIds.slice(1).map(id => storage.getState().artifacts[id]?.body)).toEqual([JSON.stringify(approval), JSON.stringify(approval)]);
                expect(storage.getState().artifacts[artifactId]?.body).toBeUndefined();
                expect(artifactIds.map(id => readsById.get(id))).toEqual([1, 1, 1]);
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
