import { afterEach, expect, it, vi } from 'vitest';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { WidgetInstanceActionInputSchemasV1, WidgetLayoutGroupV1Schema } from '@happier-dev/protocol/widgets';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { runAddWidgetLayoutFragmentCommandV1 } = await import('./widgetLayoutFragmentCommands');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
afterEach(async () => {
    await connection?.dispose();
    connection = undefined;
    await homes.reset();
});

it('carries the saved name into the real group Action approval', async () => {
    const serverId = await homes.addHome({ name: 'Home A', serverUrl: 'https://fragment-copy.test', accountId: 'account-a', currentAccount: true });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://fragment-copy.test', accountId: 'account-a',
        credentials: { token: createAccountTokenForTests('account-a', { currentAccount: true }) }, request: homes.request });
    installHomeGovernanceBoundaries(homes);
    // Explicit persisted Ask-first enters Inbox custody; default UI danger now uses Modal.confirm.
    await homes.requireUiApproval(serverId, 'widgets.group.add');
    expect(getActiveServerAccountScope()).toEqual({ serverId, accountId: 'account-a' });
    const surface = { serverId, accountId: 'account-a', owner: { kind: 'home' as const } };
    const controller = new AbortController();
    const command = runAddWidgetLayoutFragmentCommandV1({ width: 'full', frameStyle: 'card', dividers: 'hairline', children: [
        // This App widget needs no Session; an unbound session_summary correctly refuses on replay.
        { kind: 'widget', instance: { v: 1, definition: { kind: 'builtin', id: 'machine_fleet' }, bindings: {} } },
    ] }, surface, { name: 'Release checks', signal: controller.signal });
    let outcome: Awaited<typeof command> | undefined;
    void command.then(value => { outcome = value; });
    const readApproval = () => homes.artifacts(serverId).list().map(row => ({ artifactId: row.id,
        parsed: ApprovalRequestV2Schema.safeParse(JSON.parse(homes.artifacts(serverId).readPlainBody(row.id)!)) }))
        .find(row => row.parsed.success);
    try {
    await vi.waitFor(() => expect(readApproval(), JSON.stringify({ outcome,
        artifacts: homes.artifacts(serverId).list(), requests: homes.requests.map(request => request.path) })).toBeDefined());
    const approval = readApproval();
    if (!approval?.parsed.success) throw new Error('Missing canonical approval request');
    const request = approval.parsed.data;
    const args = WidgetInstanceActionInputSchemasV1['widgets.group.add'].parse(request.actionArgs);
    expect(WidgetLayoutGroupV1Schema.parse(args.group).title).toBe('Release checks');
    expect(request.preview).toMatchObject({ summary: expect.stringContaining('Release checks') });
    expect(await command).toEqual({ kind: 'approvalPending' });
    const executor = createDefaultActionExecutor();
    const decision = await executor.execute('approval.request.decide',
        { artifactId: approval.artifactId, decision: 'approve' }, { surface: 'ui', authority: 'present_user', serverId });
    expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true, result: { status: 'executed' } });
    const layout = await executor.execute('home.hub.layout.get', {}, { surface: 'ui', authority: 'present_user', serverId });
    expect(layout, JSON.stringify(layout)).toMatchObject({ ok: true, result: { layout: { items: expect.arrayContaining([
        expect.objectContaining({ kind: 'group', id: args.group.id, title: 'Release checks' }),
    ]) } } });
    } finally {
        const approval = readApproval();
        if (approval?.parsed.success && approval.parsed.data.status === 'open') await createDefaultActionExecutor().execute('approval.request.decide',
            { artifactId: approval.artifactId, decision: 'reject' }, { surface: 'ui', authority: 'present_user', serverId });
        controller.abort();
        void command;
    }
});
