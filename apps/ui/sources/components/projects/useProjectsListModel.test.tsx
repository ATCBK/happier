import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMachineFixture, createSessionListRenderableSessionFixture, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { buildProjectAccountRowPhysicalKeyV1, ProjectAccountRowMutationRequestV1Schema, ProjectAccountWorkspaceRefV1Schema, type ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { computeWorkspaceSyncPolicyDigest, WorkspaceSyncRelationshipV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { readNewSessionDraftProjectionFromRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { SessionAuthoringOpenResultV1Schema } from '@happier-dev/protocol/plugins/ui';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { forgetProjectWorkspace } = await import('@/sync/ops/actions/projectWorkspaceActions');
const confirmation = vi.hoisted(() => ({ name: 'Renamed' }));
const routerPush = vi.hoisted(() => vi.fn());
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { prompt: async () => confirmation.name } }).module;
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: routerPush } }).module;
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({});
});
const { useProjectsListModel } = await import('./useProjectsListModel');
const { ProjectsTree } = await import('./ProjectsTree');
const { buildProjectsTreeRows } = await import('./projectsTreeRows');
const { useProjectsTreeCheckoutFactsSource } = await import('./useProjectsTreeCheckoutFacts');
const { useProjectRowCreationActions } = await import('./ProjectSaveAsSourceSheet');
const { storage } = await import('@/sync/domains/state/storage');
const { clearMachineRequestReachabilityForTest } = await import('@/sync/domains/machines/reachability/machineReachability');
let serverId: string;
let rows: ProjectAccountRowV1[];
const mutationPath = '/v1/account/project-rows/mutate';
const repository = { provider: { id: 'github', kind: 'github' as const, displayName: 'GitHub', baseUrl: 'https://github.com' },
    repository: { nameWithOwner: 'owner/repo', visibility: 'private' as const }, protocol: 'https' as const };

beforeEach(async () => {
    await homes.reset(); await loadSyncSingletonForTests();
    serverId = await homes.addHome({ name: 'Projects Home', serverUrl: 'https://projects-menu.test', accountId: 'account-a' });
    rows = [{ key: { kind: 'workspace-ref', serverId, id: 'ref' }, revision: 0, content: { t: 'plain', v: {
        key: { kind: 'workspace-ref', serverId, id: 'ref' }, value: { id: 'ref', serverId, machineId: 'machine', rootPath: '/repo', projectKey: 'anchor', createdAtMs: 1 },
    } } }];
    homes.answer(serverId, 'POST /v1/account/project-rows/list', { select: () => ({ body: { status: 'listed', coverage: 'complete', rows } }) });
    homes.answer(serverId, mutationPath, { select: input => {
        const request = ProjectAccountRowMutationRequestV1Schema.parse(input);
        const changed = request.mutations.map(item => ({ key: item.key, revision: (rows.find(row => JSON.stringify(row.key) === JSON.stringify(item.key))?.revision ?? -1) + 1, content: item.content }));
        rows = [...rows.filter(row => !changed.some(item => JSON.stringify(item.key) === JSON.stringify(row.key))), ...changed];
        return { body: { status: 'updated', rows: changed, cursor: 1 } };
    } });
    homes.answer(serverId, `/v1/projects/sources?serverId=${encodeURIComponent(serverId)}&query=`, { body: { ok: true, sources: [], coverage: { complete: true, nextCursor: null } } });
    homes.answer(serverId, '/v2/cursor', { body: { cursor: '0' } });
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    await restoreConnectionToActiveServer({ token: homes.findByServerUrl('https://projects-menu.test')!.token! });
    storage.getState().activateProjectAccountRowsScope({ serverId, accountId: 'account-a' });
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    expect(await createDefaultActionExecutor().execute('projects.list', { serverId }))
        .toMatchObject({ ok: true });
    homes.requests.length = 0; routerPush.mockClear();
});
afterEach(async () => {
    await standardCleanup();
    clearMachineRequestReachabilityForTest();
    vi.useRealTimers();
    const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
    await disconnectActiveServerConnection(); await homes.reset();
});

describe('PF3 real Projects model → tree cost', () => {
    async function mountTree() {
        const machine = createMachineFixture({ id: 'machine', activeAt: Date.now() });
        storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
        const workspaceRefs = Array.from({ length: 150 }, (_, index) => ({
            id: index === 0 ? 'ref' : `ref-${index}`, serverId, machineId: machine.id,
            rootPath: index === 0 ? '/repo' : `/repo-${index}`,
            projectKey: index === 0 ? 'anchor' : `project-${index}`, createdAtMs: 1,
        }));
        applyProjectAccountRowsFixture(storage, { workspaceRefs });
        const counts = { modelRenders: 0, treeCommits: 0, rowBodies: new Map<string, number>() };
        const expandedKeys = new Set<string>();
        const renderRowMenu = (row: { key: string }) => {
            counts.rowBodies.set(row.key, (counts.rowBodies.get(row.key) ?? 0) + 1);
            return null;
        };
        const onToggle = () => {};
        let latestModel: ReturnType<typeof useProjectsListModel> | undefined;
        function ModelTree() {
            const model = useProjectsListModel();
            latestModel = model;
            counts.modelRenders += 1;
            const source = useProjectsTreeCheckoutFactsSource(model.checkoutRefs);
            const projects = model.treeProjects;
            // Same consumed model/source/row composition as ProjectsColumn; no internal mocks.
            const treeRows = React.useMemo(() => buildProjectsTreeRows({ projects, openRefId: null, expandedKeys }), [projects]);
            const live = React.useMemo(() => ({ source, projects, openRefId: null, expandedKeys }), [source, projects]);
            return <React.Profiler id="projects-tree" onRender={() => { counts.treeCommits += 1; }}>
                <ProjectsTree rows={treeRows} live={live} onToggle={onToggle}
                    onOpenRef={model.openTreeRef} renderRowMenu={renderRowMenu} />
            </React.Profiler>;
        }
        await renderScreen(<ModelTree />);
        expect(counts.rowBodies.size).toBe(150);
        counts.modelRenders = 0;
        counts.treeCommits = 0;
        counts.rowBodies.clear();
        return { counts, workspaceRefs, getModel: () => latestModel! };
    }

    it.each(['unrelated-session', 'other-home-reachability', 'unlisted-machine-success', 'reachable-machine-success'] as const)(
        'keeps 150 Projects quiet for five %s arrivals', async kind => {
            const { counts } = await mountTree();
            const { recordMachineRequestSucceeded, recordMachineRequestFailed } =
                await import('@/sync/domains/machines/reachability/machineReachability');
            for (let index = 0; index < 5; index += 1) {
                await act(async () => {
                    if (kind === 'unrelated-session') {
                        const row = createSessionListRenderableSessionFixture({ id: 'unrelated',
                            active: true, activeAt: Date.now(), thinking: Boolean(index % 2),
                            metadata: { machineId: 'machine', path: '/outside-the-tree' } });
                        storage.setState({ sessionListRowsByServerId: { [serverId]: { unrelated: row } },
                            sessionListRenderableDelta: { revision: index + 1, changedSessionIds: ['unrelated'], removedSessionIds: [], rebuiltSessionListIndex: false } });
                    } else if (kind === 'other-home-reachability') {
                        const input = { serverId: 'unrelated-home', accountId: 'unrelated-account', machineId: 'foreign', observedAtMs: Date.now() + index };
                        if (index % 2) recordMachineRequestSucceeded(input);
                        else recordMachineRequestFailed(input);
                    } else {
                        recordMachineRequestSucceeded({ serverId, accountId: 'account-a',
                            machineId: kind === 'reachable-machine-success' ? 'machine' : `unlisted-${index}` });
                    }
                });
            }
            expect({ modelRenders: counts.modelRenders, treeCommits: counts.treeCommits,
                rowBodyRenders: [...counts.rowBodies.values()].reduce((sum, value) => sum + value, 0) })
                .toEqual({ modelRenders: 0, treeCommits: 0, rowBodyRenders: 0 });
        },
    );

    // Rename, add and remove are rare, user-initiated events: they re-render the tree's sections
    // rather than isolating the unaffected ones. Pins that the change itself still reaches the rows.
    it.each(['rename', 'add', 'remove'] as const)('renders a structural %s of one Project', async kind => {
        const { counts, workspaceRefs, getModel } = await mountTree();
        const target = workspaceRefs[0]!;
        const nextRefs = kind === 'rename' ? [{ ...target, label: 'Renamed Project' }, ...workspaceRefs.slice(1)]
            : kind === 'remove' ? workspaceRefs.slice(1)
                : [...workspaceRefs, { ...target, id: 'added', projectKey: 'added-project', rootPath: '/added' }];
        const changedRef = kind === 'add' ? nextRefs[nextRefs.length - 1]! : target;
        const changedKey = buildProjectAccountRowPhysicalKeyV1({ kind: 'workspace-ref', serverId, id: changedRef.id });
        const previousRevisions = storage.getState().projectAccountRows!.revisionsByPhysicalKey;
        await act(async () => { applyProjectAccountRowsFixture(storage, { workspaceRefs: nextRefs,
            // Removal requires an explicit newer tombstone at the real admission owner;
            // omission from a census must not erase a previously admitted row.
            revisionsByPhysicalKey: { ...previousRevisions, [changedKey]: (previousRevisions[changedKey] ?? -1) + 1 },
        }); });
        const projects = getModel().treeProjects;
        expect(projects).toHaveLength(kind === 'add' ? 151 : kind === 'remove' ? 149 : 150);
        if (kind === 'rename') expect(projects.find(project => project.key === 'anchor')?.name).toBe('Renamed Project');
        if (kind === 'remove') expect(projects.some(project => project.key === 'anchor')).toBe(false);
        expect(counts.treeCommits).toBeGreaterThan(0);
        const affectedKey = kind === 'add' ? 'added-project' : 'anchor';
        if (kind !== 'remove') expect(counts.rowBodies.get(affectedKey)).toBe(1);
        else expect(counts.rowBodies.has(affectedKey)).toBe(false);
    });
});

describe('Projects model Action admission', () => {
    it('does not render 150 unchanged Projects on five admitted Machine heartbeats', async () => {
        const { observeMachinePresenceForTest } = await import('@/dev/testkit/harness/machinePresence');
        const scope = { serverId, accountId: 'account-a' };
        const machine = createMachineFixture({ id: 'machine', activeAt: Date.now() });
        storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
        observeMachinePresenceForTest(scope, [machine.id]);
        // Include the admitted Home fixture's existing anchor: this cost case
        // adds rows and does not test withdrawal of a previously admitted row.
        const workspaceRefs = Array.from({ length: 150 }, (_, index) => ({
            id: index === 0 ? 'ref' : `ref-${index}`, serverId, machineId: machine.id,
            rootPath: index === 0 ? '/repo' : `/repo-${index}`,
            projectKey: index === 0 ? 'anchor' : `project-${index}`, createdAtMs: 1,
        }));
        rows = workspaceRefs.map((ref): ProjectAccountRowV1 => {
            const key = { kind: 'workspace-ref' as const, serverId, id: ref.id };
            return { key, revision: 0, content: { t: 'plain', v: { key, value: ref } } };
        });
        applyProjectAccountRowsFixture(storage, { workspaceRefs });
        let renders = 0;
        const hook = await renderHook(() => { renders += 1; return useProjectsListModel(); });
        expect(hook.getCurrent().treeProjects).toHaveLength(150);
        const before = renders;
        for (let index = 1; index <= 5; index += 1) {
            await act(async () => {
                storage.getState().applyMachines([{ ...machine, activeAt: machine.activeAt + index }], false, { sourceServerId: serverId });
                observeMachinePresenceForTest(scope, [machine.id]);
            });
        }
        expect(renders - before).toBe(0);
        await hook.unmount();
    });

    it('never dims a retained checkout as offline while its Machine presence is withdrawn', async () => {
        const { withdrawMachinePresenceForScope, captureMachinePresenceObservation } =
            await import('@/sync/domains/machines/reachability/machineReachability');
        const machine = createMachineFixture({ id: 'machine', activeAt: Date.now() });
        storage.setState({ machines: { machine }, machineListByServerId: { [serverId]: [machine] } });
        const hook = await renderHook(() => useProjectsListModel());
        const scope = { serverId, accountId: 'account-a' };
        await act(async () => withdrawMachinePresenceForScope(scope));
        expect(hook.getCurrent().treeProjects[0]?.checkouts[0]?.offline).toBeUndefined();
        await act(async () => captureMachinePresenceObservation(scope)([machine.id]));
        expect(hook.getCurrent().treeProjects[0]?.checkouts[0]?.offline).toBe(false);
        const { recordMachineRequestFailed, recordMachineRequestSucceeded } =
            await import('@/sync/domains/machines/reachability/machineReachability');
        await act(async () => recordMachineRequestFailed({ ...scope, machineId: machine.id }));
        expect(hook.getCurrent().treeProjects[0]?.checkouts[0]?.offline).toBe(true);
        expect(hook.getCurrent().addFirstMachines).toEqual([]);
        await act(async () => recordMachineRequestSucceeded({ ...scope, machineId: machine.id }));
        expect(hook.getCurrent().treeProjects[0]?.checkouts[0]?.offline).toBe(false);
        expect(hook.getCurrent().addFirstMachines.map(machine => machine.id)).toEqual(['machine']);
        await hook.unmount();
    });

    it('disabled authoring cannot open New session here through the Projects model', async () => {
        const scope = { serverId, accountId: 'account-a' };
        const settings = { ...storage.getState().settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
            v: 1, actions: { 'session.authoring.open': { disabledSurfaces: ['ui'] } },
        }) };
        storage.getState().applySettingsForScope(scope, settings, 1);
        homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 1 } });
        const { listNewSessionDraftProjections } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const before = listNewSessionDraftProjections(scope);
        const hook = await renderHook(() => useProjectsListModel());
        const ref = hook.getCurrent().groups.projectGroups[0]!.items[0]!;
        expect(await hook.getCurrent().newSessionHere(ref)).toMatchObject({ ok: false, errorCode: 'action_disabled' });
        expect(listNewSessionDraftProjections(scope)).toEqual(before);
        expect(routerPush).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('New session here obeys the authoring Action policy before writing or opening a draft', async () => {
        await homes.requireUiApproval(serverId, 'session.authoring.open');
        const { listNewSessionDraftProjections } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const scope = { serverId, accountId: 'account-a' };
        const before = listNewSessionDraftProjections(scope);
        const sessionsBefore = storage.getState().sessions;
        const alerts = vi.spyOn((await import('@/modal')).Modal, 'alert');
        const hook = await renderHook(() => {
            const model = useProjectsListModel();
            return { ...model, rowCreation: useProjectRowCreationActions(model) };
        });
        const ref = hook.getCurrent().groups.projectGroups[0]!.items[0]!;
        await act(async () => { await hook.getCurrent().rowCreation.newSession(ref); });
        expect(listNewSessionDraftProjections(scope)).toEqual(before);
        expect(routerPush).not.toHaveBeenCalled();
        expect(storage.getState().sessions).toBe(sessionsBefore);
        expect(hook.getCurrent().projectActionApproval).toMatchObject({ actionId: 'session.authoring.open' });
        expect(alerts).not.toHaveBeenCalled();
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const executor = createDefaultActionExecutor();
        const rejectedId = hook.getCurrent().projectActionApproval?.artifactId;
        if (!rejectedId) throw new Error('Expected canonical authoring approval custody');
        expect(await executor.execute('approval.request.decide', { artifactId: rejectedId, decision: 'reject' }, { surface: 'ui', serverId }))
            .toMatchObject({ ok: true, result: { status: 'rejected' } });
        expect(listNewSessionDraftProjections(scope)).toEqual(before);
        await act(async () => { await hook.getCurrent().rowCreation.newSession(ref); });
        const approvedId = hook.getCurrent().projectActionApproval?.artifactId;
        if (!approvedId || approvedId === rejectedId) throw new Error('Expected a fresh exact authoring request');
        expect(await executor.execute('approval.request.decide', { artifactId: approvedId, decision: 'approve' }, { surface: 'ui', serverId }))
            .toMatchObject({ ok: true, result: { status: 'executed' } });
        expect(listNewSessionDraftProjections(scope)).toHaveLength(before.length + 1);
        expect(routerPush).toHaveBeenCalledTimes(1);
        expect(storage.getState().sessions).toBe(sessionsBefore);
        await hook.unmount();
    });

    it('expires a checkout online state without another Machine notification and recovers on heartbeat', async () => {
        const machine = createMachineFixture({ id: 'machine', activeAt: Date.now() });
        storage.setState({ machines: { machine }, machineListByServerId: { [serverId]: [machine] } });
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        const hook = await renderHook(() => useProjectsListModel());
        const online = () => hook.getCurrent().treeProjects[0]?.checkouts[0]?.offline === false;
        expect(online()).toBe(true);
        await act(async () => { vi.advanceTimersByTime(60_001); });
        expect(online()).toBe(false);
        const heartbeat = { ...machine, activeAt: Date.now() };
        await act(async () => { storage.setState({ machines: { machine: heartbeat }, machineListByServerId: { [serverId]: [heartbeat] } }); });
        expect(online()).toBe(true);
        await hook.unmount();
    });

    it('denied unlinked Forget leaves the accepted ref intact; granted Forget retires it', async () => {
        await homes.requireUiApproval(serverId, 'projects.workspace.forget');
        const hook = await renderHook(() => useProjectsListModel());
        const ref = hook.getCurrent().groups.projectGroups[0]!.items[0]!;
        await act(async () => { expect(await hook.getCurrent().removeProject(ref)).toMatchObject({ kind: 'approval_request_created' }); });
        expect(homes.requestsFor(mutationPath)).toEqual([]);
        expect(rows.find(row => row.key.kind === 'workspace-ref')?.content).not.toBeNull();
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const executor = createDefaultActionExecutor();
        const deniedId = hook.getCurrent().projectActionApproval?.artifactId;
        if (!deniedId) throw new Error('Expected the canonical approval receipt');
        const denial = await executor.execute('approval.request.decide', { artifactId: deniedId, decision: 'reject' }, { surface: 'ui', serverId });
        expect(denial, JSON.stringify(denial)).toMatchObject({ ok: true, result: { status: 'rejected' } });
        expect(rows.find(row => row.key.kind === 'workspace-ref')?.content).not.toBeNull();
        await act(async () => { await hook.getCurrent().removeProject(ref); });
        const grantedId = hook.getCurrent().projectActionApproval?.artifactId;
        if (!grantedId || grantedId === deniedId) throw new Error('Expected a new canonical approval request');
        await act(async () => { expect(await executor.execute('approval.request.decide', { artifactId: grantedId, decision: 'approve' }, { surface: 'ui', serverId }))
            .toMatchObject({ ok: true, result: { status: 'executed' } }); });
        expect(rows.find(row => row.key.kind === 'workspace-ref')?.content).toBeNull();
        await hook.unmount();
    });

    it('opens New session here with exact placement and offers the same Clone/Manage data', async () => {
        const hook = await renderHook(() => useProjectsListModel());
        const ref = hook.getCurrent().groups.projectGroups[0]!.items[0]!;
        const result = await hook.getCurrent().newSessionHere(ref);
        expect(result).toMatchObject({ ok: true, result: { kind: 'opened' } });
        if (!result.ok) throw new Error('Expected an admitted authoring Action');
        const opened = SessionAuthoringOpenResultV1Schema.parse(result.result);
        if (opened.kind !== 'opened') throw new Error('Expected a seeded New Session draft');
        expect(routerPush).toHaveBeenCalledWith({ pathname: '/new', params: expect.objectContaining({ draftId: expect.any(String) }) });
        expect(readNewSessionDraftProjectionFromRepository({ scope: { serverId, accountId: 'account-a' }, draftId: opened.draftId })?.draft)
            .toMatchObject({ selectedMachineId: 'machine', selectedPath: '/repo', targetServerId: serverId });
        expect(hook.getCurrent().addSources).toMatchObject({ yours: [], teams: [], onManage: expect.any(Function) });
        expect(hook.getCurrent().cloneRepository).toBeTypeOf('function');
        await hook.unmount();
    });

    it('renames, clears the label and pins the existing anchor through the admitted metadata Action', async () => {
        const hook = await renderHook(() => useProjectsListModel());
        const ref = hook.getCurrent().groups.projectGroups[0]!.items[0]!;
        await act(async () => { await hook.getCurrent().renameProject(ref); });
        expect(rows.find(row => row.key.kind === 'workspace-ref')?.content).toMatchObject({ t: 'plain', v: { value: { label: 'Renamed', projectKey: 'anchor' } } });
        await act(async () => { await hook.getCurrent().resetProjectName(ref); await hook.getCurrent().togglePinned(ref.id); });
        expect(rows.find(row => row.key.kind === 'workspace-ref')?.content).toMatchObject({ t: 'plain', v: { value: { label: null, projectKey: 'anchor' } } });
        expect(rows.find(row => row.key.kind === 'project-organization')?.content).toMatchObject({ t: 'plain', v: { value: { pinned: true } } });
        await hook.unmount();
    });

    it('routes paused relationship termination through its Action before Forget changes accepted rows', async () => {
        await homes.requireUiApproval(serverId, 'workspace.sync.relationship.terminate');
        const target = { id: 'target', serverId, machineId: 'other', rootPath: '/target', projectKey: 'anchor', createdAtMs: 1 };
        const targetKey = { kind: 'workspace-ref' as const, serverId, id: 'target' };
        const policy = { v: 1 as const, selection: 'git_worktree' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
        const relationship = WorkspaceSyncRelationshipV1Schema.parse({ v: 1, relationshipId: 'link', controllerMachineId: 'machine',
            alphaWorkspaceRefId: 'ref', betaWorkspaceRefId: 'target', mode: 'keep_synced', enabled: false,
            contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) }, createdAtMs: 1, updatedAtMs: 1 });
        const graphKey = { kind: 'relationship-graph' as const };
        rows.push({ key: targetKey, revision: 0, content: { t: 'plain', v: { key: targetKey, value: target } } },
            { key: graphKey, revision: 0, content: { t: 'plain', v: { key: graphKey, value: { relationships: [relationship] } } } });
        const sourceContent = rows[0]?.content;
        if (sourceContent?.t !== 'plain' || sourceContent.v.key.kind !== 'workspace-ref') throw new Error('Expected a plain source workspace fixture');
        applyProjectAccountRowsFixture(storage, {
            workspaceRefs: [ProjectAccountWorkspaceRefV1Schema.parse(sourceContent.v.value), target],
            relationships: [relationship],
        });
        const before = [...rows];
        vi.spyOn((await import('@/modal')).Modal, 'confirm').mockResolvedValue(true);
        const hook = await renderHook(() => useProjectsListModel());
        const ref = hook.getCurrent().groups.projectGroups.flatMap(group => group.items).find(item => item.id === 'ref');
        if (!ref) throw new Error('Expected the source workspace fixture');
        expect(storage.getState().projectAccountRows?.relationships).toHaveLength(1);
        let outcome: unknown;
        await act(async () => { outcome = await hook.getCurrent().removeProject(ref); });
        if (!outcome || typeof outcome !== 'object' || !('ok' in outcome) || outcome.ok !== true) {
            throw new Error(`Expected relationship Action admission: ${JSON.stringify(outcome)}`);
        }
        expect(outcome).toMatchObject({ kind: 'approval_request_created' });
        expect(hook.getCurrent().projectActionApproval).toMatchObject({
            actionId: 'workspace.sync.relationship.terminate',
        });
        expect(rows).toEqual(before);
        expect(homes.requestsFor(mutationPath)).toEqual([]);
        await hook.unmount();
    });

    it('includes group and direct Account grants in the shared admitted Add composition', async () => {
        const shared = [
            { id: 'group-source', revision: 1, name: 'Group source', repository, createdByAccountId: 'owner',
                audience: [{ principal: { kind: 'group', teamId: 'team', groupId: 'group' }, level: 'view' }] },
            { id: 'account-source', revision: 1, name: 'Direct source', repository, createdByAccountId: 'owner',
                audience: [{ principal: { kind: 'account', accountId: 'account-a' }, level: 'view' }] },
        ];
        homes.answer(serverId, `/v1/projects/sources?serverId=${encodeURIComponent(serverId)}&query=`, {
            body: { ok: true, sources: shared, coverage: { complete: true, nextCursor: null } },
        });
        const hook = await renderHook(() => useProjectsListModel());
        await act(async () => { await hook.getCurrent().sourceCreation.controller.load(); });
        expect(hook.getCurrent().addSources?.teams.flatMap(group => group.sources.map(source => source.id)))
            .toEqual(['group-source', 'account-source']);
        await hook.unmount();
    });

    it('creates a Source through admission and records provenance on the accepted ref without changing its anchor', async () => {
        homes.answer(serverId, '/v1/projects/sources', { body: {
            ok: true, canManage: true, source: { id: 'source-a', revision: 1,
                name: 'Repository', repository, audience: [], createdByAccountId: 'account-a' },
        } });
        const hook = await renderHook(() => useProjectsListModel());
        const ref = hook.getCurrent().groups.projectGroups[0]!.items[0]!;
        await act(async () => { expect(await hook.getCurrent().saveAsSource(ref, { name: 'Repository', repository, audience: [] }))
            .toMatchObject({ kind: 'saved', source: { id: 'source-a' } }); });
        const content = rows.find(row => row.key.kind === 'workspace-ref')?.content;
        expect(content).toMatchObject({ t: 'plain', v: { value: { projectKey: 'anchor', source: { sourceId: 'source-a', revision: 1 } } } });
        expect(homes.requestsFor('/v1/projects/sources')).toHaveLength(1);
        await hook.unmount();
    });
});
