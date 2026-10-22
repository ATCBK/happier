import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createActionExecutor, normalizeActionsSettingsV1 } from '@happier-dev/protocol';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installSessionActionFixture } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { createAppShellAction } = await import('./appShellAction');
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { captureLazyActionAccountContext } = await import('./actionAccountContext');
const originalState = storage.getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let serverId: string;
const actionId = 'session.draft.append';
const executor = () => createDefaultActionExecutor();

beforeEach(async () => {
    storage.setState(originalState, true);
    await homes.reset();
    serverId = await homes.addHome({ name: 'Draft destination', serverUrl: 'https://draft-destination.test', accountId: 'alice' });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://draft-destination.test', accountId: 'alice',
        request: createSessionReadBatchFetchBoundary(homes.request) });
    storage.getState().activateProfileScope({ serverId, accountId: 'alice' });
    await storage.getState().activateSettingsScope({ serverId, accountId: 'alice' });
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    installSessionActionFixture({ homes, storage, serverId, session: { id: 'lead' } });
    // The Home acknowledges the tuple it was asked to commit: each version advances by exactly one.
    homes.answer(serverId, 'PATCH /v2/sessions/lead', { select: input => {
        const patch = input as { mode: string; source?: { metadata: { version: number }; agentState: { version: number } };
            sharedMetadata?: { expectedVersion: number }; agentState?: { expectedVersion: number } };
        const metadata = patch.mode === 'owner_migration' ? patch.source!.metadata.version : patch.sharedMetadata!.expectedVersion;
        const agentState = patch.mode === 'owner_migration' ? patch.source!.agentState.version : patch.agentState!.expectedVersion;
        return { body: { success: true, metadataLayoutVersion: 1, sharedMetadata: { version: metadata + 1 }, agentState: { version: agentState + 1 } } };
    } });
});
afterEach(async () => {
    await connection?.dispose();
    connection = undefined;
    await homes.reset();
    storage.setState(originalState, true);
});

describe('Session draft append through the real Action executor', () => {
    it('persists an append handoff to the exact destination Home without submitting a message', async () => {
        const result = await executor().execute(actionId, {
            sessionId: 'lead', text: 'From reviewer:\nUse checkpoints.', sourceSessionId: 'lead',
        }, { surface: 'ui', authority: 'present_user', serverId, runtimeAccountId: 'alice' });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: {
            status: 'appended', sessionId: 'lead', createdAtMs: expect.any(Number),
        } });
        const writes = homes.requestsFor('/v2/sessions/lead').filter(request => request.input != null);
        expect(writes).toHaveLength(1);
        expect(writes[0]).toMatchObject({ serverId, input: { mode: 'owner_migration', target: { ownerMetadata: { t: 'plain', v: {
            history: { sessionInitialPromptV1: { v: 1, text: 'From reviewer:\nUse checkpoints.', mode: 'append', sourceSessionId: 'lead', createdAtMs: expect.any(Number) } },
        } } } } });
        expect(homes.requests.some(request => request.path.includes('/messages') && request.input != null)).toBe(false);
    });

    it('refuses disabled draft append before writing destination metadata', async () => {
        storage.getState().applySettingsLocal({ actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: { [actionId]: { enabled: false } } }) });
        const result = await executor().execute(actionId, { sessionId: 'lead', text: 'Do not append' },
            { surface: 'ui', authority: 'present_user', serverId, runtimeAccountId: 'alice' });
        expect(result).toMatchObject({ ok: false, errorCode: 'action_disabled' });
        expect(homes.requestsFor('/v2/sessions/lead').filter(request => request.input != null)).toEqual([]);
    });

    it('refuses a retired captured Account without appending under its replacement credentials', async () => {
        const account = await captureLazyActionAccountContext(serverId);
        try {
            await homes.switchAccount(serverId, 'bob');
            expect(account.accountOnlyLifetime.isCurrent()).toBe(false);
            const result = await createActionExecutor(createActionExecutorBoundaryFixture({ appShellAction: createAppShellAction(account) })).execute(actionId,
                { sessionId: 'lead', text: 'Alice draft' },
                { surface: 'ui', authority: 'present_user', serverId, runtimeAccountId: 'alice' });
            expect(result).toMatchObject({ ok: false });
            expect(homes.requestsFor('/v2/sessions/lead').filter(request => request.input != null)).toEqual([]);
        } finally { account.dispose(); }
    });
});
