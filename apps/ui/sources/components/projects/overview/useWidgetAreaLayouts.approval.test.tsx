import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { useWidgetAreaLayouts } = await import('./useProjectDashboards');
const { readPresentationNotice, retirePresentationNotice } = await import('@/components/sessions/presentation/presentationNotices');
const { t } = await import('@/text');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');

beforeEach(async () => { standardCleanup(); await homes.reset(); retirePresentationNotice(); });
afterEach(standardCleanup);

it.each(['approve', 'reject'] as const)('keeps named-layout creation pending until the exact approval is %s', async decision => {
    const serverId = await homes.addHome({ name: 'Layouts', serverUrl: 'https://layout-approval.test', accountId: 'account-a' });
    await homes.requireUiApproval(serverId, 'widgets.area.layout.create');
    const surface = { serverId, accountId: 'account-a', owner: { kind: 'project' as const, projectId: 'project-a' } };
    const hook = await renderHook(() => useWidgetAreaLayouts({ surface }));
    await vi.waitFor(() => expect(hook.getCurrent().state.status).toBe('ready'));
    let settled = false;
    let operation!: ReturnType<ReturnType<typeof hook.getCurrent>['create']>;
    await act(async () => { operation = hook.getCurrent().create('Checks').then(result => { settled = true; return result; }); });
    await vi.waitFor(() => expect(readPresentationNotice()).toMatchObject({ severity: 'info', message: t('widgetAdd.areaApprovalPending') }));
    expect(settled).toBe(false);
    const artifact = homes.artifacts(serverId).list().find(row => homes.artifacts(serverId).readPlainBody(row.id)?.includes('approval_request'));
    // The durable request body is the Action owner's output; the test never invents a receipt.
    const approval = artifact ?? homes.artifacts(serverId).list().find(row => JSON.parse(homes.artifacts(serverId).readPlainBody(row.id)!).actionId === 'widgets.area.layout.create');
    expect(approval).toBeDefined();
    expect(hook.getCurrent().approvalId).toBe(approval!.id);
    expect(hook.getCurrent().state.dashboards.some(row => row.name === 'Checks')).toBe(false);
    expect(await decideApprovalAsInbox(serverId, approval!.id, decision)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(settled).toBe(true));
    const outcome = await operation;
    if (decision === 'approve') {
        expect(outcome).toMatchObject({ ok: true, dashboard: { name: 'Checks' } });
        expect(hook.getCurrent().state.dashboards.some(row => row.name === 'Checks')).toBe(true);
    } else {
        expect(outcome).toMatchObject({ ok: false, errorCode: 'approval_rejected' });
        expect(readPresentationNotice()).toMatchObject({ severity: 'error' });
        expect(hook.getCurrent().state.dashboards.some(row => row.name === 'Checks')).toBe(false);
    }
    await hook.unmount();
});

it('keeps a plugin-stamped layout write bound to its own rejection receipt', async () => {
    const serverId = await homes.addHome({ name: 'Plugin layouts', serverUrl: 'https://plugin-layout-approval.test', accountId: 'account-a' });
    await homes.requireActionApproval(serverId, 'widgets.area.layout.create', 'plugin');
    const surface = { serverId, accountId: 'account-a', owner: { kind: 'pluginArea' as const,
        pluginId: 'example.checks', pageId: 'overview', area: 'pinned' } };
    // This is the canonical dispatcher's stamped caller; every Action/policy/Artifact reader stays real.
    const execute: import('./useProjectDashboards').WidgetAreaLayoutsExecute = (id, args) => createDefaultActionExecutor().execute(id, args, {
        surface: 'plugin', serverId, expectedAccountId: 'account-a', actionRequestId: 'plugin-layout-create',
        actionCaller: { kind: 'plugin', pluginId: 'example.checks', contributionLocalId: 'overview',
            occurrenceId: 'current-occurrence', sourceCustody: { kind: 'development', registeredRootId: 'checks-source' } },
    });
    const hook = await renderHook(() => useWidgetAreaLayouts({ surface, execute }));
    await vi.waitFor(() => expect(hook.getCurrent().state.status).toBe('ready'));
    let operation!: ReturnType<ReturnType<typeof hook.getCurrent>['create']>;
    let settled = false;
    await act(async () => { operation = hook.getCurrent().create('Checks').then(result => { settled = true; return result; }); });
    // Plugin ingress retains the invocation; its incumbent blocking owner publishes
    // the exact Artifact to Inbox instead of returning a deferred receipt to this hook.
    await vi.waitFor(() => expect(homes.artifacts(serverId).list()).toHaveLength(1));
    const artifactId = homes.artifacts(serverId).list()[0]!.id;
    expect(settled).toBe(false);
    expect(hook.getCurrent().state.dashboards.some(row => row.name === 'Checks')).toBe(false);
    expect(JSON.parse(homes.artifacts(serverId).readPlainBody(artifactId)!)).toMatchObject({
        executionOriginV1: { surface: 'plugin', authority: 'account_automation', requestId: 'plugin-layout-create',
            caller: { kind: 'plugin', pluginId: 'example.checks', contributionLocalId: 'overview' } },
    });
    expect(await decideApprovalAsInbox(serverId, artifactId, 'reject')).toMatchObject({ ok: true });
    await expect(operation).resolves.toMatchObject({ ok: false, errorCode: 'approval_rejected' });
    expect(hook.getCurrent().state.dashboards.some(row => row.name === 'Checks')).toBe(false);
    await hook.unmount();
});
