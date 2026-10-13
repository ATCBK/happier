import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit';

// This local navigation journey cannot use the recipient-envelope HTTP/process APIs.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unused = () => { throw new Error('Workspace Action reached recipient-envelope API'); };
    return { createSessionDataKeyEnvelopeClient: unused, readSessionDataKeyEnvelopeCollectionPage: unused,
        prepareSessionDataKeyEnvelopesForScope: unused, prepareSessionDataKeyEnvelopesDetached: unused };
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { executeWorkspaceUiAction, registerMountedWorkspaceAction } = await import('./workspaceActionRuntime');
const { createWorkspaceState, reduceWorkspaceState } = await import('./workspaceState');
const { createWorkspaceNavigationAdapter } = await import('./workspaceNavigationAdapter');
const { createWorkspaceActionAdapter } = await import('./workspaceActions');
const { resolveCompactAppDestinations } = await import('../destinations/compactAppDestinationCatalog');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
let unregister: (() => void) | undefined;

async function activateApprovalHome(name: string, accountId: string) {
    const serverId = await homes.addHome({ name, accountId, serverUrl: `https://${name}.test` });
    await homes.requireUiApproval(serverId, 'workspace.tabs.close_all');
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    const scope = getActiveServerAccountScope();
    if (!scope) throw new Error('Expected the fixture Home to have an applied Account runtime');
    return { serverId, scope };
}

function mountWorkspace(serverId: string) {
    let state = createWorkspaceState({ id: 'keep', target: { kind: 'session', params: { id: 'session-keep', serverId } }, pinned: true, preview: false });
    state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: {
        id: 'close', target: { kind: 'session', params: { id: 'session-close', serverId } }, pinned: false, preview: false,
    } });
    const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: true, workflows: false, friends: false } });
    const hrefs: string[] = [];
    let nextId = 0;
    const navigation = createWorkspaceNavigationAdapter({ getState: () => state, getCatalog: () => catalog,
        dispatch: action => { state = reduceWorkspaceState(state, action); }, createId: () => `new:${++nextId}`,
        onChange: () => {}, transport: { commit: href => { hrefs.push(href); } } });
    const execute = createWorkspaceActionAdapter({ getState: () => state, navigation, readCanvas: () => null, createId: () => `new:${++nextId}` });
    unregister = registerMountedWorkspaceAction(async request => execute(request.actionId, request.input));
    return { state: () => state, hrefs, openApproval: (href: string) => { navigation.openHref(href, { mode: 'newTab' }); } };
}

describe('workspace UI Action approval presentation', () => {
    beforeEach(async () => { await homes.reset(); });
    afterEach(() => { unregister?.(); unregister = undefined; publishAppliedActiveServerRuntimeAvailability(false); standardCleanup(); });

    it('opens the authenticated approval on its Home while retaining the tabs the pending close has not removed', async () => {
        const { serverId, scope } = await activateApprovalHome('workspace-approval', 'alice');
        const workspace = mountWorkspace(serverId);
        const result = await executeWorkspaceUiAction({ actionId: 'workspace.tabs.close_all', input: { groupId: 'group:1' } }, workspace.openApproval);
        expect(result).toMatchObject({ ok: true });
        if (!result.ok) throw new Error(result.error);
        const pending = ActionApprovalRequestCreatedResultSchema.parse(result.result);
        expect(homes.artifacts(serverId).readPlainBody(pending.artifactId)).not.toBeNull();
        expect(workspace.state().tabs.close).toBeDefined();
        expect(workspace.state().tabs.keep).toBeDefined();
        const opened = new URL(workspace.hrefs.at(-1) ?? '', 'https://workspace.test');
        expect(opened.pathname).toBe(`/inbox/approvals/${pending.artifactId}`);
        expect(opened.searchParams.get('serverId')).toBe(scope.serverId);
    });

    it('keeps an acknowledged approval after Account retirement without opening it in the new Account workspace', async () => {
        const { serverId } = await activateApprovalHome('workspace-original', 'alice');
        const workspace = mountWorkspace(serverId);
        let release!: () => void;
        const acknowledgment = new Promise<void>(resolve => { release = resolve; });
        homes.artifacts(serverId).afterNextCreate(() => acknowledgment);
        const pendingResult = executeWorkspaceUiAction({ actionId: 'workspace.tabs.close_all', input: { groupId: 'group:1' } }, workspace.openApproval);
        try {
            await waitForHomeGovernance(() => expect(homes.artifacts(serverId).list()).toHaveLength(1));
            await activateApprovalHome('workspace-current', 'bob');
        } finally { release(); }
        const result = await pendingResult;
        expect(result).toMatchObject({ ok: true });
        if (!result.ok) throw new Error(result.error);
        expect(ActionApprovalRequestCreatedResultSchema.safeParse(result.result).success).toBe(true);
        expect(workspace.hrefs).toEqual([]);
        expect(workspace.state().groups['group:1'].tabIds).toEqual(['keep', 'close']);
    });
});
