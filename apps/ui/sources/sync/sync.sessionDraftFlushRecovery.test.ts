import { afterAll, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { SessionDraftMutateRequestV2Schema, SessionDraftMutateResponseV2Schema } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { SessionDraftMutateRequestV1Schema, SessionDraftMutateResponseV1Schema } from '@happier-dev/protocol/drafts/sessionDrafts';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { flushHookEffects } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
// Keep the real draft persistence adapter/merge; replace only device record
// transactions so the controlled retry clock cannot block IndexedDB tasks.
vi.mock('@/sync/domains/state/browserRecordStorage', async () => {
    const { createBrowserRecordStorageModuleMock } = await import('@/dev/testkit/mocks/browserRecordStorage');
    return createBrowserRecordStorageModuleMock();
});

// Install network boundaries before the real Sync graph; load that graph once
// during collection instead of resetting and importing it inside a timed hook.
const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const drafts = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
const { restoreConnectionToActiveServer, disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
const { storage } = await import('./domains/state/storage');
const { profileDefaults } = await import('./domains/profiles/profile');
const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
const { loadSyncTuning } = await import('@/sync/runtime/syncTuning');

afterAll(async () => {
    await disconnectActiveServerConnection();
    await network.dispose();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('draft flush recovery through the connected Account', () => {
    it('automatically retries HTTP failures with the latest edit and retires recovery with its Account', async () => {
        const home = await network.addHome('https://draft-recovery.example.test', 'plain-account');
        let submissions = 0;
        let failureStatus = 500;
        const mutationPaths: string[] = [];
        network.setHttpResponder(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse({ features: {
                sessions: { drafts: { enabled: true } }, encryption: { plaintextStorage: { enabled: true }, accountOptOut: { enabled: true } },
            } }));
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: home.accountId });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (path === '/v2/account/session-drafts/list') return Response.json({ items: [] });
            if (path === '/v2/account/session-drafts/read') return Response.json({ status: 'absent' });
            if (path === '/v1/account/session-drafts/mutate' || path === '/v2/account/session-drafts/mutate') {
                const predecessor = path.startsWith('/v1/');
                const request = (predecessor ? SessionDraftMutateRequestV1Schema : SessionDraftMutateRequestV2Schema)
                    .parse(JSON.parse(String(init?.body)));
                mutationPaths.push(path);
                submissions += 1;
                // A draft-only HTTP outage never disconnects the real socket owner.
                if (submissions <= 2) return Response.json({}, { status: failureStatus });
                return Response.json((predecessor ? SessionDraftMutateResponseV1Schema : SessionDraftMutateResponseV2Schema).parse({ status: 'updated', record: {
                    address: request.address, content: request.content, revision: 0, createdAt: 1, updatedAt: 1,
                } }));
            }
            if (path === '/v1/artifacts') return Response.json([]);
            if (path === '/v1/friends') return Response.json({ friends: [] });
            if (path === '/v1/kv') return Response.json({ items: [] });
            if (path === '/v2/changes') return Response.json({ changes: [], nextCursor: 0 });
            return createEmptyAccountBootstrapHttpResponse(path, init);
        });
        await upsertAndActivateServer({ serverUrl: home.serverUrl });
        await restoreConnectionToActiveServer({ token: home.token });
        await flushHookEffects({ cycles: 8, turns: 2 });
        const scope = getActiveServerAccountScope();
        if (!scope) throw new Error('Expected the real active draft Account');
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const address = { kind: 'newSession', draftId: '00000000-0000-4000-8000-000000000885' } as const;
        drafts.writeNewSessionDraft({ scope, draftId: address.draftId, materializationIntent: 'userEdit', patch: { text: 'retain and synchronize this' } });
        expect(await drafts.flushSessionDraft({ scope, address })).toEqual({ status: 'offline' });
        expect(storage.getState().socketStatus).toBe('connected');
        await flushHookEffects({ cycles: 12, turns: 2 });
        expect(submissions).toBe(2);
        expect(drafts.getSessionDraftSnapshot(scope, address)?.status).toBe('offline');
        // Recovery reads current custody; no second flush or reconnect is sent.
        drafts.writeNewSessionDraft({ scope, draftId: address.draftId, materializationIntent: 'userEdit', patch: { text: 'latest retained edit' } });
        await flushHookEffects({ cycles: 1, turns: 2, advanceTimersMs: loadSyncTuning().invalidateSyncBackoffMinDelayMs });
        await flushHookEffects({ cycles: 12, turns: 2 });
        expect(drafts.getSessionDraftSnapshot(scope, address)).toMatchObject({
            status: 'clean', document: { composer: { text: { value: 'latest retained edit' } } },
        });
        expect(submissions).toBe(3);
        expect(new Set(mutationPaths)).toEqual(new Set(['/v1/account/session-drafts/mutate']));
        expect(storage.getState().socketStatus).toBe('connected');

        submissions = 0;
        failureStatus = 400;
        const rejectedAddress = { kind: 'newSession', draftId: '00000000-0000-4000-8000-000000000887' } as const;
        drafts.writeNewSessionDraft({ scope, draftId: rejectedAddress.draftId, materializationIntent: 'userEdit', patch: { text: 'retain after a permanent rejection' } });
        expect(await drafts.flushSessionDraft({ scope, address: rejectedAddress })).toEqual({ status: 'error' });
        await flushHookEffects({ cycles: 12, turns: 2 });
        await flushHookEffects({ cycles: 1, turns: 2, advanceTimersMs: loadSyncTuning().invalidateSyncBackoffMinDelayMs });
        expect(submissions).toBe(1);
        expect(drafts.getSessionDraftSnapshot(scope, rejectedAddress)?.document).toMatchObject({ composer: { text: { value: 'retain after a permanent rejection' } } });

        submissions = 0;
        failureStatus = 500;
        const retiredAddress = { kind: 'newSession', draftId: '00000000-0000-4000-8000-000000000886' } as const;
        drafts.writeNewSessionDraft({ scope, draftId: retiredAddress.draftId, materializationIntent: 'userEdit', patch: { text: 'stay with the retired Account' } });
        await drafts.flushSessionDraft({ scope, address: retiredAddress });
        await flushHookEffects({ cycles: 12, turns: 2 });
        expect(submissions).toBe(2);
        await disconnectActiveServerConnection();
        await flushHookEffects({ cycles: 1, turns: 2, advanceTimersMs: loadSyncTuning().invalidateSyncBackoffMinDelayMs });
        await flushHookEffects({ cycles: 12, turns: 2 });
        expect(submissions).toBe(2);
        expect(drafts.getSessionDraftSnapshot(scope, retiredAddress)).toMatchObject({
            document: { composer: { text: { value: 'stay with the retired Account' } } },
        });
    });
});
