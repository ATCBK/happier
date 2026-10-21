import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, answerDiscussionThreadForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { DiscussionSettingsSetRequestV1Schema, type DiscussionSettingsV1 } from '@happier-dev/protocol/discussions/settings';

vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { createDiscussionClient } = await import('./discussionActions');
await import('@/sync/ops/actions/defaultActionExecutor');
beforeEach(async () => { await homes.reset(); });
afterEach(() => { standardCleanup(); });

it('reads and changes Discussion check-in settings through the captured Account Action path without conflating inherit and Never', async () => {
    const serverId = await homes.addHome({ name: 'Discussion settings', serverUrl: 'https://discussion-settings.test', accountId: 'alice', currentAccount: true });
    const discussionId = 'configured-discussion';
    const path = `/v1/discussions/${discussionId}/settings`;
    let settings: { coordination?: { autonomousCheckIn: { afterTurns: number | null } } } = {};
    let returnedDiscussionId = discussionId;
    homes.answer(serverId, `GET ${path}`, { select: () => ({ body: { discussionId: returnedDiscussionId, settings } }) });
    homes.answer(serverId, `PUT ${path}`, { select: input => {
        expect(input).toEqual({ settings: { coordination: { autonomousCheckIn: { afterTurns: null } } } });
        settings = { coordination: { autonomousCheckIn: { afterTurns: null } } };
        return { body: { discussionId, settings } };
    } });
    const client = createDiscussionClient({ scope: { serverId, accountId: 'alice' }, availability: 'available' });
    expect(await client.getSettings(discussionId)).toEqual({ kind: 'succeeded', value: { discussionId, settings: {} } });
    expect(await client.setSettings(discussionId, { coordination: { autonomousCheckIn: { afterTurns: null } } }))
        .toEqual({ kind: 'succeeded', value: { discussionId, settings: { coordination: { autonomousCheckIn: { afterTurns: null } } } } });
    settings = { coordination: { autonomousCheckIn: { afterTurns: 9 } } };
    expect(await client.getSettings(discussionId)).toMatchObject({ kind: 'succeeded', value: { settings } });
    returnedDiscussionId = 'different-discussion';
    expect(await client.getSettings(discussionId)).toEqual({ kind: 'failed', errorCode: 'discussion_not_found' });
    expect(homes.requestsFor(path).every(request => request.serverId === serverId)).toBe(true);
});

it('provides the demanded menu override and withdraws it on Account retirement, including a late settings read', async () => {
    const { createDiscussionRepository } = await import('@/sync/ops/discussions/discussionRepository');
    const { useServerCredentialAccountScopeBindings } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
    const { useDiscussionSettings } = await import('@/components/discussions/useDiscussionSettings');
    const serverId = await homes.addHome({ name: 'Check-in menu', serverUrl: 'https://check-in-menu.test', accountId: 'alice', currentAccount: true });
    const scope = { serverId, accountId: 'alice' };
    answerDiscussionThreadForTests(homes, serverId, { loseCreate: false, loseFirstRejoin: false });
    const client = createDiscussionClient({ scope, availability: 'available' });
    expect((await client.create({ creationLocalId: 'settings-thread', messageLocalId: 'settings-root', title: 'Review',
        content: { v: 1, parts: [{ t: 'text', text: 'Start here' }] } })).kind).toBe('succeeded');
    const discussionId = 'committed-thread';
    const path = `/v1/discussions/${discussionId}/settings`;
    let settings: DiscussionSettingsV1 = {};
    let holdRead: Promise<void> | undefined;
    homes.answer(serverId, `GET ${path}`, { select: () => ({ respondAfter: holdRead, body: { discussionId, settings } }) });
    homes.answer(serverId, `PUT ${path}`, { select: input => {
        settings = DiscussionSettingsSetRequestV1Schema.parse(input).settings;
        return { body: { discussionId, settings } };
    } });
    const repository = createDiscussionRepository({ scope, address: { serverId }, client });
    await repository.refreshDiscussion(discussionId);
    const hook = await renderHook(() => {
        const bindings = useServerCredentialAccountScopeBindings([serverId]);
        return useDiscussionSettings({ repository, discussionId, accountLifetime: bindings.get(serverId) ?? null, enabled: true });
    });
    await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'ready', canManage: true }));
    expect(hook.getCurrent().override).toBeUndefined();
    await act(async () => { await hook.getCurrent().dontPause(); });
    expect(hook.getCurrent().override).toEqual({ afterTurns: null });
    await act(async () => { await hook.getCurrent().setOverride(8); });
    expect(hook.getCurrent().override).toEqual({ afterTurns: 8 });
    await act(async () => { await hook.getCurrent().inherit(); });
    expect(hook.getCurrent().override).toBeUndefined();
    const deferred = createDeferred<void>();
    holdRead = deferred.promise;
    let read: Promise<unknown> | undefined;
    await act(async () => { read = hook.getCurrent().refresh(); });
    await act(async () => { await homes.switchAccount(serverId, 'bob'); });
    expect(hook.getCurrent().override).toBeNull();
    expect(hook.getCurrent().canManage).toBe(false);
    await act(async () => { deferred.resolve(); await read; });
    expect(hook.getCurrent().override).toBeNull();
    expect(homes.requestsFor(path).filter(request => request.input !== null)).toHaveLength(3);
    await hook.unmount();
});
