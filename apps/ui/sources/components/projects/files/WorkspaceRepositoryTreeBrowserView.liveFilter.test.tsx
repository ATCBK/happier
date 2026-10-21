import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { createReducer } from '@happier-dev/session-core/reducer';
import { DaemonFilesystemListDirectoryRequestSchema } from '@happier-dev/protocol/machines/fileBrowser';

import { createCapturingLegendListMock, createMachineFixture, createSessionFixture, renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from '@/components/sessions/panes/sessionDetailsPanelTestHelpers';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { storage } from '@/sync/domains/state/storageStore';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';

installSessionDetailsPanelCommonModuleMocks();
const runtime = installSessionPaneRuntimeTestHarness();
type RpcRequest = Parameters<typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc').machineRpcWithServerScope>[0];
const rpc = vi.hoisted(() => vi.fn<(request: RpcRequest) => Promise<unknown>>());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(rpc);
});
// Virtualization is a native boundary; tree, settlement and search owners stay real.
vi.mock('@legendapp/list/react-native', () => createCapturingLegendListMock({ renderItems: true }).module);
// Prepare cold runtime modules before the Account lifecycle starts its hook budget.
await (await import('@/dev/testkit/harness/syncSingletonLoader')).loadSyncSingletonForTests();
const { WorkspaceRepositoryTreeBrowserView } = await import('./WorkspaceRepositoryTreeBrowserView');

describe('WorkspaceRepositoryTreeBrowserView live filtering', () => {
    it('reconciles an ignored cached child directory while inline results replace the rows', async () => {
        const scope = { serverId: runtime.serverId, machineId: 'filter-machine', rootPath: '/filter-repo' };
        const machine = createMachineFixture({ id: scope.machineId, activeAt: Date.now() });
        storage.setState({
            machines: { [machine.id]: machine }, machineListByServerId: { [scope.serverId]: [machine] },
            sessions: { s1: createSessionFixture({ id: 's1', serverId: scope.serverId,
                active: true, activeAt: Date.now(), thinking: true, thinkingAt: Date.now(), latestTurnStatus: 'in_progress',
                metadata: { path: scope.rootPath, machineId: scope.machineId, host: 'test' } }) },
            sessionMessages: { s1: { messageIdsOldestFirst: [], messagesById: {}, messagesMap: {},
                reducerState: createReducer(), messagesVersion: 1, isLoaded: true,
                latestThinkingMessageId: null, latestThinkingMessageActivityAtMs: null } },
            sessionListRowsByServerId: {}, sessionListIndexByServerId: {}, ordinarySessionListMembershipByServerId: {},
        });
        let children = ['before.txt'];
        rpc.mockImplementation(async request => {
            const parsed = DaemonFilesystemListDirectoryRequestSchema.safeParse(request.payload);
            if (!parsed.success) return { ok: true, paths: [], truncated: false };
            const path = parsed.data.path;
            return { ok: true, path, truncated: false, gitIgnoreAvailable: true, entries: path === scope.rootPath
                ? [{ name: 'tmp', path: `${path}/tmp`, type: 'directory', gitIgnored: true }]
                : children.map(name => ({ name, path: `${path}/${name}`, type: 'file', gitIgnored: true })) };
        });
        const expandedPaths = ['tmp'];
        const onExpandedPathsChange = () => {};
        const render = (query: string) => <runtime.Wrapper><WorkspaceRepositoryTreeBrowserView
            scope={scope} searchQuery={query} onSearchQueryChange={() => {}} onOpenFile={() => {}}
            scmSnapshot={null} expandedPaths={expandedPaths} onExpandedPathsChange={onExpandedPathsChange}
            transferEffectsEnabled={false}
        /></runtime.Wrapper>;
        const screen = await renderScreen(render(''));
        // All files admits the ignored directory, so SCM signatures cannot repair it incidentally.
        const { useRepositoryTreeBrowserState } = await import('@/hooks/workspaces/files/repositoryTreeBrowserState');
        const { renderHook } = await import('@/dev/testkit');
        const { buildWorkspaceCacheKey } = await import('@/sync/domains/workspaces/workspaceScope');
        const state = await renderHook(() => useRepositoryTreeBrowserState(buildWorkspaceCacheKey(scope)));
        await act(async () => state.getCurrent().setVisibilityMode('all'));
        await vi.waitFor(() => expect(screen.findHostByTestId(`repository-tree-row-${toTestIdSafeValue('tmp/before.txt')}`) !== null).toBe(true));
        await screen.update(render('needle'));
        await act(async () => {
            storage.getState().applyMessages('s1', [{
                id: 'filter-write', localId: null, createdAt: Date.now(), role: 'agent', isSidechain: false,
                content: [{ type: 'tool-call', id: 'filter-write-tool', name: 'Write', input: { file_path: `${scope.rootPath}/tmp/new.txt`, content: 'new' },
                    description: null, uuid: 'filter-write-uuid', parentUUID: null }],
            }]);
        });
        children = ['before.txt', 'new.txt'];
        await act(async () => {
            storage.getState().applyMessages('s1', [{
                id: 'filter-write-result', localId: null, createdAt: Date.now() + 1, role: 'agent', isSidechain: false,
                content: [{ type: 'tool-result', tool_use_id: 'filter-write-tool', content: 'settled', is_error: false,
                    uuid: 'filter-result-uuid', parentUUID: null }],
            }]);
        });
        await screen.update(render(''));
        await vi.waitFor(() => expect(screen.findHostByTestId(`repository-tree-row-${toTestIdSafeValue('tmp/new.txt')}`) !== null).toBe(true));
    });
});
