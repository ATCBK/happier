// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { createDeferred, standardCleanup } from '@/dev/testkit';
import { createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { Socket } from 'socket.io-client';
import { SessionOrganizationSnapshotResponseSchema } from '@happier-dev/protocol/sessions/organization/snapshot';
import { createSessionOwnerMetadataV1, projectSessionSharedMetadataV1, sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary(configureConnectedServerSocketBoundary);
await loadSyncSingletonForTests();
const { useSessionAwareness } = await import('./useSessionAwareness');
const { useServerCredentialAccountScopeBindings } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { storage } = await import('@/sync/domains/state/storageStore');
const { isSessionListRowVisible, getVisibleSessionSurfaces, clearSessionSurfaceVisibilityForServerScopeReset } = await import('../sessionSurfaceVisibility');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
afterEach(async () => { await standardCleanup(); await connection?.dispose(); connection = undefined; });

it.each(['plain', 'e2ee', 'retired'] as const)('hydrates a never-opened scoped participant without a transcript, sharing the read and retaining live demand (%s)', async mode => {
    const sessionId = `cold-participant-${mode}`;
    const now = Date.now();
    const request = { tool: 'Bash', kind: 'permission', arguments: { command: 'sleep 300' }, createdAt: now, turnId: 'cold-turn' };
    const state = { requests: { 'exec-cold': request } };
    const { Encryption } = await import('@/sync/encryption/encryption');
    const { encodeBase64 } = await import('@/encryption/base64');
    const { deriveAccountSigningPublicKey } = await import('@/auth/flows/challenge');
    const secret = new Uint8Array(32).fill(31);
    const writer = mode === 'e2ee' ? await Encryption.create(secret) : null;
    let row = SessionCurrentProjectionRecordV1Schema.parse({ ...createPlainSessionCurrentProjectionRecordFixture({ id: sessionId,
        active: true, activeAt: now, updatedAt: now }), agentState: JSON.stringify(state), agentStateVersion: 1,
        pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0, pendingRequestObservedAt: null });
    if (writer) {
        const dataKey = new Uint8Array(32).fill(41);
        await writer.initializeSessions(new Map([[sessionId, dataKey]]));
        const codec = writer.getSessionEncryption(sessionId)!;
        const metadata = { path: '/repo', host: 'fixture' };
        const owner = createSessionOwnerMetadataV1({ metadata });
        if (!owner.ok) throw new Error('Cold Session owner metadata fixture was rejected');
        row = SessionCurrentProjectionRecordV1Schema.parse({ ...row, encryptionMode: 'e2ee',
            metadata: await codec.encryptRaw(projectSessionSharedMetadataV1({ metadata })), agentState: await codec.encryptRaw(state),
            ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({ material: { type: 'legacy', secret }, ownerMetadata: owner.ownerMetadata,
                randomBytes: length => new Uint8Array(length).fill(31) }),
            dataEncryptionKey: encodeBase64(await writer.encryptEncryptionKey(dataKey)) });
    }
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    const observed: string[] = [];
    const boundary = createSessionReadBatchHttpBoundary(async request => {
        if (request.path !== `/v2/sessions/${sessionId}`) return undefined;
        started.resolve();
        await release.promise;
        return Response.json({ session: row });
    });
    let participantSocket: Socket | undefined;
    const { profileDefaults } = await import('@/sync/domains/profiles/profile');
    connection = await restoreServerAccountForTest({ serverUrl: `https://cold-awareness-${mode}.test`,
        accountId: 'cold-account', ...(writer ? { credentials: { token: createAccountTokenForTests('cold-account'), secret: encodeBase64(secret, 'base64url') } } : {}),
        configureSocket: socket => { configureConnectedServerSocketBoundary(socket); participantSocket = socket; },
        request: async (url, init) => {
            const target = new URL(String(url));
            const path = target.pathname;
            observed.push(path);
            if (path === '/v2/sessions/read-batch' || path === `/v2/sessions/${sessionId}`) return await boundary.handle({
                home: mode, accountId: 'cold-account', url: target, path, method: init?.method ?? 'GET',
                headers: new Headers(init?.headers), signal: init?.signal, body: init?.body ? JSON.parse(String(init.body)) : undefined,
            }) ?? null;
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/account/encryption/currentness') return Response.json(writer ? {
                mode: 'e2ee', version: 1, updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' },
                signingKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(deriveAccountSigningPublicKey(secret)),
                contentKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(writer.contentDataKey),
            } : createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/account/encryption') return Response.json({ mode: writer ? 'e2ee' : 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings') return Response.json(writer ? { content: null, version: 0 } : { content: { t: 'plain', v: {} }, version: 1 });
            if (path === '/v2/cursor') return Response.json({ cursor: 0 });
            if (path === '/v2/sessions' || path === '/v2/sessions/active') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
            if (path === '/v2/sessions/metadata-upgrades') return Response.json({ sessionIds: [] });
            if (path === '/v2/session-organization') return Response.json(SessionOrganizationSnapshotResponseSchema.parse({ snapshot: {
                schemaVersion: 1, version: 0, pins: [], folders: [], folderAssignments: [], tags: [], tagAssignments: [], orderEntries: [], labels: [],
            } }));
            if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: 'cold-account' });
            if (path === '/v1/account/authoring-memory') return Response.json({ rows: [] });
            if (path === '/v1/account/project-rows/list') {
                const census = createPlainProjectAccountRowListFixture();
                return Response.json(writer ? { ...census, rows: [] } : census);
            }
            if (path === '/v1/machines' || path === '/v1/artifacts') return Response.json([]);
            if (path === '/v1/kv') return Response.json({ items: [] });
            if (path === '/v1/feed') return Response.json({ items: [], hasMore: false });
            if (path === '/v1/account/saved-secrets/resources/materials') return Response.json({ resources: [] });
            if (path === '/v3/automations/runs/workflow-storage') return Response.json({ runs: [], acceptedEnvelopesByRunId: {}, keyCensusByRunId: {} });
            return null;
        } });
    const serverId = connection.home.id;
    expect(storage.getState().sessions[sessionId]).toBeUndefined();
    let enabled = false;
    const scopeState: { lifetime: ServerAccountScopeLifetime | null } = { lifetime: null };
    let values: ReturnType<typeof useSessionAwareness>[] = [];
    function Probe() {
        const scopes = useServerCredentialAccountScopeBindings([serverId]);
        const accountLifetime = scopes.get(serverId) ?? null;
        scopeState.lifetime = accountLifetime;
        values = [
            useSessionAwareness(sessionId, serverId, undefined, { accountLifetime, enabled }),
            useSessionAwareness(sessionId, serverId, undefined, { accountLifetime, enabled }),
        ];
        return null;
    }
    // Exercise the real hook with the DOM platform renderer; no canonical DOM hook helper exists.
    // Unlike this host's split react-test-renderer peer, React DOM shares the app's actual React.
    const root = createRoot(document.createElement('div'));
    const rerender = () => act(async () => { root.render(<Probe />); });
    await rerender();
    await vi.waitFor(() => expect(scopeState.lifetime).not.toBeNull());
    const capturedLifetime = scopeState.lifetime!;
    try {
        expect(isSessionListRowVisible(sessionId, serverId)).toBe(false);
        expect(observed.some(path => path === `/v2/sessions/${sessionId}` || path === '/v2/sessions/read-batch')).toBe(false);
        enabled = true;
        await rerender();
        if (mode === 'retired') {
            await vi.waitFor(() => expect(observed.some(path => path === '/v2/sessions/read-batch' || path === `/v2/sessions/${sessionId}`)).toBe(true));
            await started.promise;
            await act(async () => { await connection?.dispose(); connection = undefined; });
        }
        await act(async () => { release.resolve(); });
        if (mode === 'retired') {
            await vi.waitFor(() => expect(capturedLifetime.isCurrent()).toBe(false));
            expect(values.every(value => value.oldestPendingRequest === null)).toBe(true);
            expect(storage.getState().sessions[sessionId]).toBeUndefined();
        } else {
            await vi.waitFor(() => expect(values.map(value => value.oldestPendingRequest?.id)).toEqual(['exec-cold', 'exec-cold']));
            expect(values[0].awareness?.operational.primary).toBe('permission_required');
            expect(isSessionListRowVisible(sessionId, serverId)).toBe(true);
            expect(observed.filter(path => path === '/v2/sessions/read-batch' || path === `/v2/sessions/${sessionId}`)).toHaveLength(1);
            expect(getVisibleSessionSurfaces().some(value => value.sessionId === sessionId)).toBe(false);
            expect(observed.some(path => path.includes(`/sessions/${sessionId}/messages`))).toBe(false);
            // Real registered socket listeners must clear the cold-acquired request after settlement.
            const settledState = { requests: {}, completedRequests: { 'exec-cold': { ...request, status: 'approved', completedAt: now + 1 } } };
            const settledValue = writer ? await writer.getSessionEncryption(sessionId)!.encryptRaw(settledState) : JSON.stringify(settledState);
            expect(participantSocket?.listenersAny().length).toBeGreaterThan(0);
            await act(async () => {
                for (const listener of participantSocket!.listenersAny()) listener('update', { id: 'settled-native-request', seq: 1, createdAt: now + 1,
                    body: { t: 'update-session', id: sessionId, metadataLayoutVersion: row.metadataLayoutVersion,
                        pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0,
                        agentState: { version: 2, value: settledValue } } });
            });
            await vi.waitFor(() => expect(values.every(value => value.oldestPendingRequest === null)).toBe(true));
            expect(observed.some(path => path.includes(`/sessions/${sessionId}/messages`))).toBe(false);
            const nextState = { ...settledState, requests: { 'exec-next': { ...request, createdAt: now + 2 } } };
            const nextValue = writer ? await writer.getSessionEncryption(sessionId)!.encryptRaw(nextState) : JSON.stringify(nextState);
            await act(async () => {
                for (const listener of participantSocket!.listenersAny()) listener('update', { id: 'next-native-request', seq: 2, createdAt: now + 2,
                    body: { t: 'update-session', id: sessionId, metadataLayoutVersion: row.metadataLayoutVersion,
                        pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0,
                        agentState: { version: 3, value: nextValue } } });
            });
            await vi.waitFor(() => expect(values.map(value => value.oldestPendingRequest?.id)).toEqual(['exec-next', 'exec-next']));
            expect(observed.some(path => path.includes(`/sessions/${sessionId}/messages`))).toBe(false);
            await act(async () => { clearSessionSurfaceVisibilityForServerScopeReset(); });
            expect(isSessionListRowVisible(sessionId, serverId)).toBe(true);
            enabled = false;
            await rerender();
            expect(isSessionListRowVisible(sessionId, serverId)).toBe(false);
            expect(values.every(value => value.oldestPendingRequest === null)).toBe(true);
        }
    } finally {
        release.resolve();
        await act(async () => { root.unmount(); });
    }
});
