import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionIdSchema, createActionExecutor, normalizeActionsSettingsV1 } from '@happier-dev/protocol';
import { SESSION_DRAFT_V2_ROUTE_READ } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol';

const navigation = vi.hoisted(() => ({ pushes: [] as unknown[] }));
vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    router: { push: (route: unknown) => navigation.pushes.push(route) },
}).module);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { createAppShellAction } = await import('./appShellAction');
const { captureLazyActionAccountContext } = await import('./actionAccountContext');
const { writeNewSessionDraft, resetSessionDraftRepositoryForTests, getSessionDraftSnapshot } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
const originalState = storage.getState();
let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;
let serverId: string;
let accountId: string;
const draftId = '00000000-0000-4000-8000-000000000081';

beforeEach(async () => {
    storage.setState(originalState, true);
    resetSessionDraftRepositoryForTests();
    navigation.pushes.length = 0;
    const features = createRootLayoutFeaturesResponse();
    if (!tryWriteServerEnabledBitInPlace(features, 'sessions.drafts', true)) throw new Error('Draft feature fixture is unavailable');
    account = await createSecretSettingsTestHarness({ features });
    ({ serverId, accountId } = account.scope);
    writeNewSessionDraft({ scope: account.scope, draftId, materializationIntent: 'userEdit', patch: { text: 'Keep the saved prompt' } });
});
afterEach(async () => {
    await account?.dispose();
    account = undefined;
    resetSessionDraftRepositoryForTests();
    storage.setState(originalState, true);
});

describe('saved New Session draft Action', () => {
    it('opens the exact persisted draft and Home without replacing its prompt or creating another draft', async () => {
        const actionId = ActionIdSchema.parse('session.draft.open');
        const before = getSessionDraftSnapshot({ serverId, accountId }, { kind: 'newSession', draftId });
        const result = await createDefaultActionExecutor().execute(actionId, { draftId },
            { surface: 'ui', authority: 'present_user', serverId, runtimeAccountId: accountId });
        expect(result).toMatchObject({ ok: true, result: { status: 'opened', draftId } });
        expect(navigation.pushes).toEqual([{ pathname: '/new', params: {
            draftId, spawnServerId: serverId, draftServerId: serverId, draftAccountId: accountId,
        } }]);
        expect(getSessionDraftSnapshot({ serverId, accountId }, { kind: 'newSession', draftId })).toEqual(before);
    });
    it('does not navigate when draft opening is disabled', async () => {
        const actionId = ActionIdSchema.parse('session.draft.open');
        if (!account) throw new Error('Account fixture missing');
        account.replaceSettings(settingsParse({ ...storage.getState().settings,
            actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: { [actionId]: { enabled: false } } }),
        }));
        const result = await createDefaultActionExecutor().execute(actionId, { draftId },
            { surface: 'ui', authority: 'present_user', serverId, runtimeAccountId: accountId });
        expect(result).toMatchObject({ ok: false, errorCode: 'action_disabled' });
        expect(navigation.pushes).toEqual([]);
    });
    it('reports a missing draft without opening or creating one', async () => {
        if (!account) throw new Error('Account fixture missing');
        const originalRequest = account.request.getMockImplementation()!;
        account.request.mockImplementation(async (input, init) => new URL(String(input)).pathname === SESSION_DRAFT_V2_ROUTE_READ
            ? Response.json({ status: 'absent' }) : originalRequest(input, init));
        const missingId = '00000000-0000-4000-8000-000000000099';
        const result = await createDefaultActionExecutor().execute(ActionIdSchema.parse('session.draft.open'), { draftId: missingId },
            { surface: 'ui', authority: 'present_user', serverId, runtimeAccountId: accountId });
        expect(result).toMatchObject({ ok: true, result: { status: 'missing' } });
        expect(navigation.pushes).toEqual([]);
        expect(getSessionDraftSnapshot({ serverId, accountId }, { kind: 'newSession', draftId: missingId })).toBeNull();
    });
    it('refuses another Account when supplied the captured saved-draft owner', async () => {
        const owner = await captureLazyActionAccountContext(serverId);
        try {
            const executor = createActionExecutor({ appShellAction: createAppShellAction(owner) });
            const result = await executor.execute(ActionIdSchema.parse('session.draft.open'), { draftId },
                { surface: 'ui', authority: 'present_user', serverId, runtimeAccountId: 'another-account' });
            expect(result).toMatchObject({ ok: true, result: { status: 'unavailable' } });
            expect(navigation.pushes).toEqual([]);
        } finally { owner.dispose(); }
    });
});
