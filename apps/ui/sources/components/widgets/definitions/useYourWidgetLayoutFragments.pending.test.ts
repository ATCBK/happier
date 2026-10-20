import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, flushHookEffects, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const modal = vi.hoisted(() => ({ prompt: vi.fn(), alert: vi.fn(), confirm: vi.fn() }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: modal }).module);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { useYourWidgetLayoutFragments } = await import('./useYourWidgetLayoutFragments');
const { readPresentationNotice, retirePresentationNotice } = await import('@/components/sessions/presentation/presentationNotices');
const { storage } = await import('@/sync/domains/state/storage');
const { t } = await import('@/text');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
afterEach(async () => {
    standardCleanup();
    retirePresentationNotice();
    await connection?.dispose();
    connection = undefined;
    await homes.reset();
    vi.clearAllMocks();
});

describe('saved-group pending management', () => {
    it.each(['rename', 'duplicate', 'delete'] as const)('keeps %s pending without blocking or reverting its optimistic name', async intent => {
        const serverId = await homes.addHome({ name: 'Home A', serverUrl: 'https://fragments-pending.test', accountId: 'account-a' });
        const account = { serverId, accountId: 'account-a' };
        connection = await restoreServerAccountForTest({ serverUrl: 'https://fragments-pending.test', accountId: 'account-a', request: homes.request });
        installHomeGovernanceBoundaries(homes);
        storage.setState({ profileScope: account, settingsScope: account });
        await homes.requireUiApproval(serverId, intent === 'rename' ? 'widgets.fragment.update'
            : intent === 'delete' ? 'widgets.fragment.delete' : 'widgets.fragment.duplicate');
        expect(await createDefaultActionExecutor().execute('widgets.fragment.create', { account, artifactId: 'saved', fragment: {
            name: 'Release checks', inputs: { fields: [] }, inputSchema: { type: 'object' },
            group: { width: 'full', frameStyle: 'card', dividers: 'hairline', children: [{ kind: 'widget',
                instance: { v: 1, definition: { kind: 'builtin', id: 'session_summary' }, bindings: {} } }] },
        } }, { serverId, surface: 'ui', authority: 'present_user' })).toMatchObject({ ok: true });
        const original = homes.artifacts(serverId).readPlainBody('saved');
        const hook = await renderHook(() => useYourWidgetLayoutFragments(account));
        await vi.waitFor(() => expect(hook.getCurrent().fragments).toHaveLength(1));
        modal.prompt.mockResolvedValue('Release room');
        const onPress = hook.getCurrent().actionsFor(hook.getCurrent().fragments[0]!).find(action => action.id === intent)?.onPress;
        if (!onPress) throw new Error(`Expected the saved group to offer ${intent}`);
        await act(async () => {
            onPress();
            await flushHookEffects({ cycles: 2 });
        });
        await vi.waitFor(() => expect(homes.artifacts(serverId).list()).toHaveLength(2));
        await vi.waitFor(() => expect(readPresentationNotice()).toMatchObject({ severity: 'info' }));
        expect(readPresentationNotice()?.message).toContain(t(`common.${intent}`));
        expect(readPresentationNotice()?.message).toContain(t('approvals.waitingForYou'));
        expect(modal.alert).not.toHaveBeenCalled();
        expect(modal.confirm).not.toHaveBeenCalled();
        expect(hook.getCurrent().fragments[0]?.name).toBe(intent === 'rename' ? 'Release room' : 'Release checks');
        expect(homes.artifacts(serverId).readPlainBody('saved')).toBe(original);
        expect(homes.artifacts(serverId).list()).toHaveLength(2);
    });
});
