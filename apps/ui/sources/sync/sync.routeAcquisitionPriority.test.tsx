import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { createDeferred, renderHook, renderScreen } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createPlainSessionCurrentProjectionRecordFixture, createSessionFixture, createSessionOwnerViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { SessionOrganizationSnapshotResponseSchema } from '@happier-dev/protocol/sessions/organization/snapshot';
import { SESSION_ORGANIZATION_SNAPSHOT_VERSION } from '@happier-dev/protocol/sessions/organization/constants';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { ApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';

const route = vi.hoisted(() => ({ serverId: '' }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: () => '/session/opened', params: () => ({ id: 'opened', serverId: route.serverId }) }).module;
});

// Transform the app graph during collection, with the canonical transport
// boundary installed first. Per-case resets below still rebuild its real
// wiring; cold source compilation must not consume the route contract's clock.
const preloadNetwork = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
await preloadNetwork.dispose();

describe('Workspace foreground Session acquisition', () => {
    beforeEach(() => vi.resetModules());
    it.each(['plain', 'e2ee', 'http-failure'] as const)('prioritizes the routed Session before Account inventory and resumes background work (%s)', async mode => {
        let phase = 'network-boundary';
        onTestFinished(() => console.info(`route-acquisition ${mode} phase=${phase}`));
        const network = await installSessionOpsNetworkBoundary();
        const exactFailure = mode === 'http-failure';
        const { Encryption } = await import('./encryption/encryption');
        const { encodeBase64 } = await import('@/encryption/base64');
        const { deriveAccountSigningPublicKey } = await import('@/auth/flows/challenge');
        const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        const secret = new Uint8Array(32).fill(31);
        phase = 'writer-create';
        const writer = mode === 'e2ee' ? await Encryption.create(secret) : null;
        const accountId = `route-priority-${mode}`;
        const credentials = writer ? { token: createAccountTokenForTests(accountId), secret: encodeBase64(secret, 'base64url') } : undefined;
        const home = await network.addHome(`https://route-priority-${mode}.example.test`, accountId,
            writer ? { credentials, encryptionMode: 'e2ee' } : {});
        const secondaryHome = mode === 'plain'
            ? await network.addHome('https://route-priority-secondary.example.test', 'secondary-account')
            : null;
        let sessionRow = createPlainSessionCurrentProjectionRecordFixture({ id: 'opened' });
        if (writer) {
            phase = 'writer-initialize';
            const dataKey = new Uint8Array(32).fill(41);
            await writer.initializeSessions(new Map([['opened', dataKey]]));
            const { ownerMetadata: _ownerMetadata, ...legacyRow } = sessionRow;
            sessionRow = SessionCurrentProjectionRecordV1Schema.parse({ ...legacyRow,
                encryptionMode: 'e2ee', metadataLayoutVersion: 0,
                metadata: await writer.getSessionEncryption('opened')!.encryptRaw({ path: '/workspace', host: 'fixture' }),
                dataEncryptionKey: encodeBase64(await writer.encryptEncryptionKey(dataKey)),
            });
        }
        route.serverId = home.id;
        // Window identity and browser History are platform boundaries. The
        // workspace's real restoration/admission and route owner run below them.
        const events = new EventTarget();
        const history = { state: null as unknown,
            replaceState: (state: unknown) => { history.state = state; },
            pushState: (state: unknown) => { history.state = state; }, go() {},
        };
        vi.stubGlobal('window', { history,
            location: { pathname: '/session/opened', search: `?serverId=${home.id}`, hash: '' },
            sessionStorage: { getItem: () => 'route-priority-window' },
            addEventListener: events.addEventListener.bind(events),
            removeEventListener: events.removeEventListener.bind(events),
            dispatchEvent: events.dispatchEvent.bind(events),
        });
        const profile = createDeferred<void>();
        const profileStarted = createDeferred<void>();
        const exact = createDeferred<void>();
        const exactStarted = createDeferred<void>();
        const observed: string[] = [];
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => home.accountId, encryptionMode: 'plain' });
        const { profileDefaults } = await import('./domains/profiles/profile');
        network.setHttpResponder(async (input, init) => {
            const path = new URL(String(input)).pathname;
            observed.push(path);
            if (path.startsWith('/v1/artifacts/')) return artifacts.handle(path, init);
            if (path === '/v1/account/encryption/currentness') return Response.json(writer ? {
                mode: 'e2ee', version: 1, updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' },
                signingKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(deriveAccountSigningPublicKey(secret)),
                contentKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(writer.contentDataKey),
            } : createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/account/encryption') return Response.json({ mode: writer ? 'e2ee' : 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings') return Response.json(writer ? { content: null, version: 0 } : { content: { t: 'plain', v: {} }, version: 1 });
            if (path === '/v1/account/authoring-memory') return Response.json({ rows: [] });
            if (path === '/v1/account/project-rows/list') {
                const census = createPlainProjectAccountRowListFixture();
                // A fresh encrypted Account has no Project rows yet; a plain
                // relationship envelope would violate its real mode boundary.
                return Response.json(writer ? { ...census, rows: [] } : census);
            }
            if (path === '/v1/account/profile') {
                profileStarted.resolve();
                await profile.promise;
                return Response.json({ ...profileDefaults, id: home.accountId });
            }
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v2/cursor') return Response.json({ cursor: 0 });
            if (path === '/v2/changes') return Response.json({ changes: [], nextCursor: 0 });
            if (path === '/v2/sessions' || path === '/v2/sessions/active') {
                if (writer) expect(sync.encryption?.getSessionEncryption('opened')).toBeTruthy();
                const sessions = mode === 'plain' ? ['offscreen-active', 'offscreen-report'].map(id => ({
                    ...createPlainSessionCurrentProjectionRecordFixture({ id }),
                    active: true,
                })) : [];
                return Response.json({ sessions, nextCursor: null, hasNext: false });
            }
            if (path === '/v2/session-organization') return Response.json(SessionOrganizationSnapshotResponseSchema.parse({ snapshot: {
                schemaVersion: SESSION_ORGANIZATION_SNAPSHOT_VERSION, version: 0, pins: [], folders: [], folderAssignments: [],
                tags: [], tagAssignments: [], orderEntries: [], labels: [],
            } }));
            if (path === '/v2/sessions/opened') {
                exactStarted.resolve();
                await exact.promise;
                if (exactFailure) return Response.json({ error: 'temporarily unavailable' }, { status: 503 });
                return Response.json({ session: {
                    ...sessionRow,
                    viewer: createSessionOwnerViewerFixture(createSessionFixture({ id: 'opened' })),
                } });
            }
            if (path === '/v2/sessions/offscreen-active' || path === '/v2/sessions/offscreen-report') {
                const id = path.split('/').at(-1)!;
                return Response.json({ session: {
                    ...createPlainSessionCurrentProjectionRecordFixture({ id }),
                    viewer: createSessionOwnerViewerFixture(createSessionFixture({ id })),
                } });
            }
            if (path === '/v1/machines' || path === '/v1/artifacts') return Response.json([]);
            if (path === '/v1/account/saved-secrets/resources/materials') return Response.json({ resources: [] });
            if (path === '/v3/automations/runs/workflow-storage') return Response.json({ runs: [], acceptedEnvelopesByRunId: {}, keyCensusByRunId: {} });
            if (path === '/v1/kv') return Response.json({ items: [] });
            if (path === '/v1/feed') return Response.json({ items: [], hasMore: false });
            return null;
        });
        phase = 'sync-load';
        await loadSyncSingletonForTests();
        const { upsertAndActivateServer } = await import('./domains/server/serverRuntime');
        const { restoreConnectionToActiveServer, disconnectActiveServerConnection } = await import('./runtime/orchestration/connectionManager');
        const { storage } = await import('./domains/state/storage');
        const { sync, syncSwitchServer } = await import('./sync');
        const { WorkspaceProvider } = await import('@/components/appShell/workspace/WorkspaceProvider');
        const { resolveCompactAppDestinations } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
        const { useHydrateSessionForRoute } = await import('@/hooks/session/useHydrateSessionForRoute');
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: false, friends: false } });
        function SessionBody() {
            const state = useHydrateSessionForRoute('opened', 'route-priority', { serverId: home.id, hydrateMessages: false });
            return state.kind === 'available' ? React.createElement('ReadableSessionBody') : null;
        }
        await syncSwitchServer(null);
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        let background: Awaited<ReturnType<typeof renderHook>> | undefined;
        const backgroundReads: Promise<unknown>[] = [];
        let disposeAccount: (() => void) | undefined;
        try {
            phase = 'workspace-render';
            screen = await renderScreen(<WorkspaceProvider enabled catalog={catalog}>
                {navigation => navigation.active ? <SessionBody /> : null}
            </WorkspaceProvider>);
            phase = 'restore';
            await act(async () => {
                await upsertAndActivateServer({ serverUrl: home.serverUrl });
                await restoreConnectionToActiveServer(credentials ?? { token: home.token });
            });
            phase = 'profile-transport';
            await vi.waitFor(() => expect(observed).toContain('/v1/account/profile'));
            await profileStarted.promise;
            await vi.waitFor(() => expect(observed).toContain('/v2/sessions/opened'), { timeout: 2000 });
            await exactStarted.promise;
            if (mode === 'plain') {
                // Shell summaries, voice credentials and Home layout use these
                // real owners independently of Sync's inventory queues.
                const { refreshSavedSecretCatalog } = await import('./engine/settings/savedSecretCatalogEngine');
                const { captureLazyActionAccountContext } = await import('./ops/actions/actionAccountContext');
                const { useWorkflowRunWindow } = await import('@/components/workflows/library/workflowLibraryReads');
                const account = await captureLazyActionAccountContext(home.id);
                disposeAccount = account.dispose;
                backgroundReads.push(refreshSavedSecretCatalog(account.accountLifetime.scope).catch(() => undefined));
                backgroundReads.push(account.workflowArtifacts.list({}).catch(() => undefined));
                background = await renderHook(() => useWorkflowRunWindow('attention'));
                const approval = ApprovalRequestSchema.parse({
                    v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
                    createdBy: { surface: 'mcp' }, requestedSurface: 'mcp',
                    executionOriginV1: { v: 1, authority: 'account_automation', surface: 'mcp', caller: { kind: 'host' },
                        serverId: home.id, accountId: home.accountId, actionId: 'ui.voice_global.get', requestId: 'foreground-approval' },
                    actionId: 'ui.voice_global.get', actionArgs: {}, summary: 'Read Voice state',
                });
                await artifacts.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({
                    id: 'foreground-approval', header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(approval)),
                    body: encodePlainArtifactStoredContent({ body: JSON.stringify(approval) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                }) });
                const { createDefaultActionExecutor } = await import('./ops/actions/defaultActionExecutor');
                let approvalResult: unknown;
                const approving = createDefaultActionExecutor().execute('approval.request.decide', {
                    artifactId: 'foreground-approval', decision: 'approve',
                }, { surface: 'ui', serverId: home.id }).then(result => { approvalResult = result; });
                backgroundReads.push(approving);
                // This exact user decision must finish while the unrelated
                // initial Session and all background inventories remain held.
                await vi.waitFor(() => expect(approvalResult).toMatchObject({ ok: true, result: { status: 'executed' } }));
                expect(JSON.parse(artifacts.readPlainBody('foreground-approval') ?? 'null')).toMatchObject({
                    status: 'executed', decision: { kind: 'approve' }, execution: { ok: true },
                });
            }
            let visibleListRead: Promise<unknown> | undefined;
            await act(async () => {
                // The mounted list uses this same page owner while the direct
                // destination is still opening. It must share route priority.
                visibleListRead = sync.fetchSessionListQueryPage(home.id, {
                    source: { kind: 'ordinary', path: '/v2/sessions', allowV1Fallback: false },
                    membership: 'ordinary', signal: new AbortController().signal,
                });
            });
            expect(storage.getState().isDataReady).toBe(false);
            expect(observed).not.toContain('/v2/sessions');
            // Endpoint reachability can arrive while initial route acquisition
            // is held. Its real resume path must yield to that same admission.
            let startupResume: Promise<void> | undefined;
            await act(async () => {
                profile.resolve();
                startupResume = sync.resumeSync('server-reachable');
            });
            await vi.waitFor(() => expect(storage.getState().isDataReady).toBe(true));
            expect(observed).not.toContain('/v2/sessions');
            expect(observed).not.toContain('/v1/machines');
            expect(observed).not.toContain('/v1/account/authoring-memory');
            expect(observed).not.toContain('/v1/account/project-rows/list');
            if (mode === 'plain') {
                expect(observed).not.toContain('/v1/account/saved-secrets/resources/materials');
                expect(observed).not.toContain('/v1/artifacts');
                expect(observed).not.toContain('/v3/automations/runs/workflow-storage');
            }
            await act(async () => { exact.resolve(); });
            phase = 'route-publication';
            if (exactFailure) {
                expect(screen!.root.findAllByType('ReadableSessionBody')).toHaveLength(0);
                expect(storage.getState().sessions.opened).toBeUndefined();
            } else {
                await vi.waitFor(() => expect(screen!.root.findAllByType('ReadableSessionBody')).toHaveLength(1));
                expect(storage.getState().sessions.opened).toMatchObject({ id: 'opened', serverId: home.id });
            }
            await vi.waitFor(() => expect(observed).toContain('/v2/sessions'));
            await vi.waitFor(() => expect(observed).toContain('/v1/machines'));
            await vi.waitFor(() => expect(observed).toContain('/v1/account/authoring-memory'));
            await vi.waitFor(() => expect(observed).toContain('/v1/account/project-rows/list'));
            await startupResume;
            await visibleListRead;
            if (mode === 'plain') {
                await vi.waitFor(() => expect(observed).toContain('/v1/account/saved-secrets/resources/materials'));
                await vi.waitFor(() => expect(observed).toContain('/v1/artifacts'));
                await vi.waitFor(() => expect(observed).toContain('/v3/automations/runs/workflow-storage'));
                await Promise.all(backgroundReads);
            }
            phase = 'background-resumed';
            if (!exactFailure) expect(observed.filter(path => path === '/v2/sessions/opened')).toHaveLength(1);
            if (mode === 'plain') {
                await vi.waitFor(() => expect(storage.getState().sessionListRowsByServerId[home.id]?.['offscreen-active']).toBeTruthy());
                const { retainVisibleSessionListSurfaces, getVisibleSessionSurfaces, markSessionSurfaceVisible,
                    markSessionSurfaceHidden, setFocusedSessionId, clearFocusedSessionId } = await import('./domains/session/sessionSurfaceVisibility');
                const { beginSessionViewingActivation, endSessionViewingActivation } = await import('./domains/session/readState/sessionManualUnreadHold');
                if (!secondaryHome) throw new Error('The secondary Home fixture is unavailable');
                // The same Home-local id may be visible and focused on another Home.
                // Its view activation must not open the active Home's unrelated row.
                markSessionSurfaceVisible('offscreen-active', secondaryHome.id);
                setFocusedSessionId('offscreen-active', secondaryHome.id);
                const secondaryActivation = beginSessionViewingActivation('offscreen-active');
                const hydrationDemand = sync as unknown as { getActiveSessionHydrationIds(): string[] };
                try {
                    expect(hydrationDemand.getActiveSessionHydrationIds()).not.toContain('offscreen-active');
                    await sync.refreshSessions({ awaitSessionListHydration: true });
                    expect(Object.keys(storage.getState().sessions)).toEqual(['opened']);
                } finally {
                    endSessionViewingActivation('offscreen-active', secondaryActivation);
                    clearFocusedSessionId('offscreen-active', secondaryHome.id);
                    markSessionSurfaceHidden('offscreen-active', secondaryHome.id);
                }
                const address = { serverId: home.id, sessionId: 'offscreen-active' };
                // The real virtualizer publishes this summary demand without
                // acquiring transcript visibility or requesting its messages.
                const release = retainVisibleSessionListSurfaces([address]);
                try {
                    await sync.hydrateSessionListRows([address]);
                    expect(storage.getState().sessions['offscreen-active']).toMatchObject({
                        id: address.sessionId,
                        serverId: address.serverId,
                    });
                    expect(storage.getState().sessions['offscreen-report']).toBeUndefined();
                    expect(getVisibleSessionSurfaces().some(surface => surface.sessionId === address.sessionId)).toBe(false);
                    expect(observed).not.toContain('/v1/sessions/offscreen-active/messages');
                } finally { release(); }
                // An existing activation without any scoped surface remains the
                // incumbent unqualified fallback; no new Home policy is introduced.
                const unqualifiedActivation = beginSessionViewingActivation('offscreen-report');
                try {
                    expect(hydrationDemand.getActiveSessionHydrationIds()).toContain('offscreen-report');
                } finally { endSessionViewingActivation('offscreen-report', unqualifiedActivation); }
            }
        } finally {
            profile.resolve();
            exact.resolve();
            await screen?.unmount();
            await background?.unmount();
            disposeAccount?.();
            await disconnectActiveServerConnection();
            await network.dispose();
            vi.restoreAllMocks();
            vi.unstubAllGlobals();
        }
    }, 120_000);
});
