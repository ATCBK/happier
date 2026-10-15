import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { storage } = await import('@/sync/domains/state/storage');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { useHomeHubArtifactLayout } = await import('./useHomeHubArtifactLayout');
const { readPresentationNotice, retirePresentationNotice } = await import('@/components/sessions/presentation/presentationNotices');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
afterEach(async () => {
    standardCleanup();
    retirePresentationNotice();
    await connection?.dispose();
    connection = undefined;
    await homes.reset();
});

it('offers review when the real Home queue creates a group-removal approval without Sections mounted', async () => {
    const serverId = await homes.addHome({ name: 'Home', serverUrl: 'https://home-group-approval.test', accountId: 'account-a' });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://home-group-approval.test', accountId: 'account-a', request: homes.request });
    installHomeGovernanceBoundaries(homes);
    const scope = { serverId, accountId: 'account-a' };
    const settings = { ...storage.getState().settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
        actions: { 'widgets.item.remove': { approvalRequiredSurfaces: ['ui'] } },
    }) };
    storage.setState({ isDataReady: true, profileScope: scope, settingsScope: scope, settings });
    homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 1 } });
    const executor = createDefaultActionExecutor();
    expect(await executor.execute('home.hub.layout.update', { intent: { kind: 'group_add', group: {
        kind: 'group', id: 'own-group', title: 'Release checks', width: 'full', frameStyle: 'card', dividers: 'hairline',
        children: [{ kind: 'widget', instance: { v: 1, id: 'child', definition: { kind: 'builtin', id: 'session_summary' }, bindings: {} } }],
    } } }, { surface: 'ui', authority: 'present_user', serverId, bypassApprovals: true })).toMatchObject({ ok: true });
    const hook = await renderHook(useHomeHubArtifactLayout, { wrapper: ({ children }: React.PropsWithChildren) =>
        <InjectedAuthProvider credentials={connection!.credentials}>{children}</InjectedAuthProvider> });
    await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
    await act(async () => { void hook.getCurrent().dispatch({ kind: 'remove', instanceId: 'own-group' }); });
    await vi.waitFor(() => expect(homes.artifacts(serverId).list().some(artifact => {
        const body = homes.artifacts(serverId).readPlainBody(artifact.id);
        return body !== null && JSON.parse(body).actionId === 'widgets.item.remove';
    })).toBe(true));
    await vi.waitFor(() => expect(readPresentationNotice()).toMatchObject({ severity: 'info', undo: {
        label: expect.any(String), run: expect.any(Function),
    } }));
    expect(hook.getCurrent().layout.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'own-group' })]));
});
