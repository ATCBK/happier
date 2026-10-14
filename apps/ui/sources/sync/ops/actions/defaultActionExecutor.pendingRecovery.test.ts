import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, standardCleanup } from '@/dev/testkit';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';

// HTTP, device credentials and native confirmation are the only substituted boundaries.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { Modal } = await import('@/modal');

beforeEach(async () => {
    await homes.reset();
    await loadSyncSingletonForTests();
    vi.mocked(Modal.confirm).mockClear();
    vi.mocked(Modal.confirm).mockResolvedValue(true);
});
afterEach(async () => { await standardCleanup(); await homes.reset(); });

const actionIds = ['session.pending.markHandled', 'session.pending.dismiss', 'session.pending.sendAsNew'] as const;
type RecoveryActionId = typeof actionIds[number];

async function targetFixture(actionId: RecoveryActionId, allow = false) {
    const serverId = await homes.addHome({ name: 'Pending Home', serverUrl: 'https://pending-recovery.test', accountId: 'pending-owner', active: false });
    await homes.addHome({ name: 'Focused Home', serverUrl: 'https://pending-focused.test', accountId: 'focused-owner' });
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    if (allow) homes.answer(serverId, '/v2/account/settings', { body: AccountSettingsV2GetResponseSchema.parse({
        content: { t: 'plain', v: { actionsSettingsV1: normalizeActionsSettingsV1({
            v: 1, actions: {}, approvalWaivedSurfaces: { [actionId]: ['ui'] },
        }) } }, version: 1,
    }) });
    const targetExecutionRunId = actionId === 'session.pending.markHandled' ? undefined : 'run/one';
    const owner = `/v2/sessions/session/pending`;
    const target = targetExecutionRunId ? '/v2/sessions/session/execution-runs/run%2Fone/pending' : owner;
    const operation = actionId === 'session.pending.markHandled' ? 'handled' : actionId === 'session.pending.dismiss' ? 'dismiss' : 'send-as-new';
    const path = `${target}/input/delivery/${operation}`;
    homes.answer(serverId, `POST ${path}`, { body: { ok: true, newLocalId: 'replacement' } });
    homes.answer(serverId, `GET ${target}?includeDiscarded=1`, { body: { pending: [] } });
    const input = { sessionId: 'session', localId: 'input', serverId, ...(targetExecutionRunId ? { targetExecutionRunId } : {}) };
    const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId, expectedAccountId: 'pending-owner' };
    return { serverId, path, input, context };
}

describe('registered UI Pending recovery Action delivery', () => {
    it.each(actionIds)('executes %s at the captured background Home after exactly one policy confirmation', async actionId => {
        const { path, serverId, input, context } = await targetFixture(actionId);
        expect(await createDefaultActionExecutor().execute(actionId, input, context)).toEqual({ ok: true,
            result: actionId === 'session.pending.sendAsNew' ? { newLocalId: 'replacement' } : { ok: true } });
        expect(Modal.confirm).toHaveBeenCalledOnce();
        expect(homes.requestsFor(path)).toMatchObject([{ serverId }]);
        expect(homes.requests.filter(request => request.path.includes('/delivery/'))).toHaveLength(1);
    });

    it('honors an Always allow choice without opening a confirmation', async () => {
        const { path, input, context } = await targetFixture('session.pending.markHandled', true);
        expect(await createDefaultActionExecutor().execute('session.pending.markHandled', input, context)).toEqual({ ok: true, result: { ok: true } });
        expect(Modal.confirm).not.toHaveBeenCalled();
        expect(homes.requestsFor(path)).toHaveLength(1);
    });

    it('does not mutate when confirmation is denied', async () => {
        const { path, input, context } = await targetFixture('session.pending.dismiss');
        vi.mocked(Modal.confirm).mockResolvedValueOnce(false);
        expect(await createDefaultActionExecutor().execute('session.pending.dismiss', input, context)).toMatchObject({ ok: false, errorCode: 'approval_canceled' });
        expect(homes.requestsFor(path)).toEqual([]);
    });

    it('does not borrow replacement Account authority after a confirmation is left open', async () => {
        const { path, serverId, input, context } = await targetFixture('session.pending.sendAsNew');
        const confirming = createDeferred<void>();
        const decision = createDeferred<boolean>();
        vi.mocked(Modal.confirm).mockImplementationOnce(() => { confirming.resolve(undefined); return decision.promise; });
        const action = createDefaultActionExecutor().execute('session.pending.sendAsNew', input, context);
        await confirming.promise;
        await homes.switchAccount(serverId, 'replacement-owner');
        decision.resolve(true);
        expect(await action).toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
        expect(homes.requestsFor(path)).toEqual([]);
    });
});
