import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HandoffTargetReplacementPreflightV1Schema, WorkspaceSyncRelationshipCreateRpcRequestV1Schema,
    WorkspaceSyncRelationshipCreateResultV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createMachineFixture, invokeTestInstanceHandler, pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createWorkspaceSyncHarness, type WorkspaceSyncRpcRequest } from '@/dev/testkit/harness/workspaceSyncHarness';

const shownModal = vi.hoisted(() => vi.fn());
const confirmModal = vi.hoisted(() => vi.fn(async () => false));
const daemonRpc = vi.hoisted(() => vi.fn<(request: WorkspaceSyncRpcRequest) => unknown>());
const projectsOpenOutcome = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key, vars) => vars ? key + ':' + JSON.stringify(vars) : key,
}));
// Genuine boundary: the Home-side `projects.open` Action. Every other Action keeps the real executor.
vi.mock('@/sync/ops/actions/defaultActionExecutor', async importOriginal => {
    const real = await importOriginal<typeof import('@/sync/ops/actions/defaultActionExecutor')>();
    return {
        ...real,
        createDefaultActionExecutor: (...args: Parameters<typeof real.createDefaultActionExecutor>) => {
            const executor = real.createDefaultActionExecutor(...args);
            return { ...executor, execute: (...call: Parameters<typeof executor.execute>) => (
                call[0] === 'projects.open' && projectsOpenOutcome.current ? Promise.resolve(projectsOpenOutcome.current) : executor.execute(...call)
            ) } as typeof executor;
        },
    };
});
vi.mock('@/modal', async () => {
    const boundary = (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
        confirmResult: true, spies: { confirm: confirmModal },
    });
    shownModal.mockImplementation(boundary.spies.show);
    return { ...boundary.module, Modal: { ...boundary.module.Modal, show: shownModal } };
});

const workspace = createWorkspaceSyncHarness(request => daemonRpc(request));
await workspace.ready;
const { storage } = await import('@/sync/domains/state/storage');
const { MachineSelector } = await import('@/components/sessions/new/components/MachineSelector');
const { PathSelectionList } = await import('@/components/ui/pathPicker/PathSelectionList');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
const owner = await import('./openWorkspaceSyncAddMachine');

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

let pendingCreate = deferred<unknown>();
let pendingPreflight = deferred<unknown>();
let requireApproval = false;
let holdPreflight = false;
let targetFolder: 'nonempty' | 'empty' | 'missing' = 'nonempty';

const source = () => ({ id: 'source-ref', serverId: workspace.serverId, machineId: 'machine-a', rootPath: '/source' });
const callsFor = (method: string) => daemonRpc.mock.calls.map(([request]) => request).filter(request => request.method === method);

function targetApproval(request: WorkspaceSyncRpcRequest) {
    const input = HandoffTargetReplacementPreflightV1Schema.parse(request.payload);
    return { type: 'approval_required', approval: { v: 1,
        consequences: input.activatesExactMirror
            ? ['replace_nonempty_workspace_target', 'delete_target_only_files_during_exact_mirror']
            : ['replace_nonempty_workspace_target'],
        serverId: input.serverId, machineId: input.machineId, canonicalRoot: input.targetPath,
        rootFingerprint: 'a'.repeat(64), operationId: input.operationId,
    } };
}

function committedLink() {
    const request = callsFor(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE)[0];
    if (!request) throw new Error('Expected a dispatched relationship creation');
    const { actionInput } = WorkspaceSyncRelationshipCreateRpcRequestV1Schema.parse(request.payload);
    return WorkspaceSyncRelationshipCreateResultV1Schema.parse({ v: 1, relationshipId: 'created-relationship', created: true,
        controllerMachineId: 'machine-a', sourceWorkspaceRefId: actionInput.sourceWorkspaceRefId,
        targetWorkspaceRefId: 'target-ref', status: { relationshipId: 'created-relationship', controllerMachineId: 'machine-a',
            state: 'watching', alphaPath: '/source', betaPath: actionInput.targetPath, mode: actionInput.mode,
            endpointStates: { alpha: null, beta: null }, conflictCount: 0, lastCycleObservedAtMs: null },
    });
}

function storedApproval() {
    const artifacts = workspace.home.artifacts(workspace.serverId);
    const artifact = artifacts.list().find(row => artifacts.readPlainBody(row.id)?.includes('"actionId":"workspace.sync.relationship.create"'));
    if (!artifact) throw new Error('Expected the Home to persist a relationship approval');
    return StoredApprovalRequestSchema.parse(JSON.parse(artifacts.readPlainBody(artifact.id)!));
}

beforeEach(async () => {
    await workspace.reset();
    shownModal.mockClear();
    confirmModal.mockClear();
    daemonRpc.mockReset();
    pendingCreate = deferred();
    pendingPreflight = deferred();
    requireApproval = false;
    holdPreflight = false;
    targetFolder = 'nonempty';
    projectsOpenOutcome.current = null;
    const machines = [['machine-a', 'Source', '/home/source'], ['machine-b', 'Target', '/home/target']].map(([id, displayName, homeDir]) => {
        const machine = createMachineFixture({ id, activeAt: Date.now() });
        return { ...machine, metadata: { ...machine.metadata!, displayName, homeDir } };
    });
    storage.getState().applyMachines(machines, true, { sourceServerId: workspace.serverId, sourceAccountId: workspace.accountId });
    storage.getState().markMachineListSettled(workspace.serverId);
    applyProjectAccountRowsFixture(storage, { workspaceRefs: [{ ...source(), createdAtMs: 1 }], relationships: [] });
    daemonRpc.mockImplementation(request => {
        if (request.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT) {
            return holdPreflight ? pendingPreflight.promise : requireApproval ? targetApproval(request) : { type: 'not_required' };
        }
        if (request.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE) return pendingCreate.promise;
        if (request.method === RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY) {
            const input = request.payload as { path: string };
            if (targetFolder === 'missing') return { ok: false, error: `ENOENT: no such file or directory, scandir '${input.path}'` };
            const entries = targetFolder === 'nonempty' ? [{ name: '.git', path: `${input.path}/.git`, type: 'directory' }] : [];
            return { ok: true, path: input.path, entries, truncated: false };
        }
        if (request.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_LIST) return { statuses: [] };
        throw new Error('Unexpected workspace sync RPC ' + request.method);
    });
});

afterEach(async () => {
    standardCleanup();
    await workspace.dispose();
});

async function renderOpenedModal() {
    const config = shownModal.mock.calls[0]?.[0];
    expect(config).toBeTruthy();
    const onClose = vi.fn();
    const setChrome = vi.fn();
    const screen = await renderScreen(React.createElement(config.component, { ...config.props, onClose, setChrome }));
    const submit = () => {
        const footer = setChrome.mock.lastCall?.[0]?.footer as React.ReactElement<{ children?: React.ReactNode }>;
        const button = React.Children.toArray(footer.props.children).find(child => React.isValidElement(child)
            && (child.props as { testID?: string }).testID === 'workspace-sync-add-machine-submit');
        if (!React.isValidElement<{ onPress: () => void; disabled: boolean }>(button)) throw new Error('Expected the Add machine submit control');
        return button;
    };
    return { config, onClose, screen, submit };
}

const statusLine = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.findAllByType(SurfaceStateCard)
    .find(node => node.props.testID === 'workspace-sync-add-machine-status');

async function chooseTarget(screen: Awaited<ReturnType<typeof renderScreen>>, path = '/target', machineId = 'machine-b') {
    const target = storage.getState().machines[machineId];
    await act(async () => { invokeTestInstanceHandler(screen.findByType(MachineSelector), 'onSelect', target); });
    await act(async () => { invokeTestInstanceHandler(screen.findByType(PathSelectionList), 'onCommit', path); });
}

async function startAddMachineLink(options: Readonly<{
    configure?: (screen: Awaited<ReturnType<typeof renderScreen>>) => Promise<void>;
    waitFor?: string;
}> = {}) {
    owner.openWorkspaceSyncAddMachine(source(), vi.fn());
    const modal = await renderOpenedModal();
    await chooseTarget(modal.screen);
    await options.configure?.(modal.screen);
    await vi.waitFor(() => expect(modal.submit().props.disabled).toBe(false));
    await act(async () => { modal.submit().props.onPress(); });
    await vi.waitFor(() => expect(callsFor(options.waitFor ?? RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE), modal.screen.getTextContent()).toHaveLength(1));
    return modal;
}

describe('Project Add machine modal', () => {
    it('opens a missing-worker-copy refusal in the existing create flow, leaving the path for the user to choose', async () => {
        requireApproval = true;
        expect(owner.openWorkspaceSyncWorkerCopySetup({ ...source(), workspaceId: source().id }, {
            kind: 'no_worker_can_accept', reason: 'worker_copy_missing', unavailable: 'ask',
            workerCopy: { serverId: workspace.serverId, sourceWorkspaceRefId: source().id,
                sourceMachineId: 'machine-a', targetMachineId: 'machine-b' },
        }, vi.fn())).toBe(true);
        const modal = await renderOpenedModal();
        expect(modal.screen.findByType(MachineSelector).props.selectedMachine?.id).toBe('machine-b');
        expect(modal.screen.findByType(PathSelectionList).props.initialValue).toBe('');
        expect(callsFor(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE)).toEqual([]);
        await act(async () => invokeTestInstanceHandler(modal.screen.findByType(PathSelectionList), 'onCommit', '/chosen-worker'));
        await vi.waitFor(() => expect(modal.submit().props.disabled).toBe(false));
        await act(async () => { modal.submit().props.onPress(); });
        await vi.waitFor(() => expect(confirmModal).toHaveBeenCalledOnce());
        expect(storedApproval().actionArgs).toMatchObject({ sourceWorkspaceRefId: source().id, targetMachineId: 'machine-b',
            targetPath: '/chosen-worker', purpose: 'worker_clean_copy', mode: 'keep_synced', destinationIntent: 'materialize_from_source_workspace' });
        expect(callsFor(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE)).toEqual([]);
    });

    it('does not open setup for stale source facts or an unrelated refusal', () => {
        const address = { ...source(), workspaceId: source().id };
        expect(owner.openWorkspaceSyncWorkerCopySetup(address, { kind: 'no_worker_can_accept', reason: 'not_accepting', unavailable: 'ask' }, vi.fn())).toBe(false);
        expect(owner.openWorkspaceSyncWorkerCopySetup(address, { kind: 'no_worker_can_accept', reason: 'worker_copy_missing', unavailable: 'ask',
            workerCopy: { serverId: 'another-home', sourceWorkspaceRefId: source().id, sourceMachineId: 'machine-a', targetMachineId: 'machine-b' } }, vi.fn())).toBe(false);
        expect(shownModal).not.toHaveBeenCalled();
    });

    it('names the source folder relative to its machine home', async () => {
        owner.openWorkspaceSyncAddMachine({ ...source(), rootPath: '/home/source/project' }, vi.fn());
        const { screen } = await renderOpenedModal();
        expect(screen.getTextContent()).toContain('workspaceSync.endpoint.source:{"label":"~/project"}');
        expect(screen.getTextContent()).toContain('Source');
        expect(screen.getTextContent()).not.toContain('/home/source/project');
    });

    it('preserves the shared raw policy draft and submits exact-replica destination intent', async () => {
        requireApproval = true;
        await startAddMachineLink({ waitFor: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT, configure: async screen => {
            const selectMenu = async (title: string, value: string) => {
                const menu = screen.findAllByType(DropdownMenu).find(node => node.props.itemTrigger?.title === title);
                expect(menu).toBeTruthy();
                await act(async () => invokeTestInstanceHandler(menu!, 'onSelect', value));
            };
            await selectMenu('sessionHandoff.targetApproval.modeLabel', 'mirror_exactly');
            await selectMenu('workspaceSync.addMachine.folderSetup', 'materialize_from_source_workspace');
            const advanced = screen.findAll(node => node.props.title === 'settingsSession.handoff.advanced.title'
                && typeof node.props.onPress === 'function')[0];
            expect(advanced).toBeTruthy();
            await pressTestInstanceAsync(advanced!, 'show advanced workspace policy');
            await selectMenu('settingsSession.handoff.contentSelection.title', 'all_files');
            await selectMenu('settingsSession.handoff.includeIgnoredMode.title', 'include_selected');
            const field = () => screen.find(node => typeof node.type === 'string'
                && node.props.accessibilityLabel === 'settingsSession.handoff.includeIgnoredMode.globsTitle');
            for (const draft of ['dist/**,', 'dist/**, ', 'dist/**, .env.local']) {
                await act(async () => invokeTestInstanceHandler(field(), 'onChangeText', draft));
                expect(field().props.value).toBe(draft);
            }
        } });
        await vi.waitFor(() => expect(confirmModal).toHaveBeenCalledOnce());
        expect(storedApproval().actionArgs).toMatchObject({ mode: 'mirror_exactly', destinationIntent: 'materialize_from_source_workspace',
            contentPolicy: { selection: 'all_files', extraIncludePatterns: ['dist/**', '.env.local'] } });
        expect(confirmModal).toHaveBeenCalledWith('sessionHandoff.targetApproval.title',
            expect.stringContaining('sessionHandoff.targetApproval.exactMirror'), expect.anything());
    });

    describe('Use existing folder for a Git source', () => {
        const unavailable = 'settingsSession.handoff.targetBootstrap.useExistingUnavailable';
        const destinationMenu = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.findAllByType(DropdownMenu)
            .find(node => node.props.itemTrigger?.title === 'workspaceSync.addMachine.folderSetup')!;
        const useExisting = (screen: Awaited<ReturnType<typeof renderScreen>>) => (destinationMenu(screen).props.items as ReadonlyArray<{ id: string; disabled?: boolean; subtitle?: string }>)
            .find(item => item.id === 'use_existing')!;

        it.each(['missing', 'empty'] as const)('disables it for a %s folder with its reason and prepares the folder instead', async (state) => {
            targetFolder = state;
            requireApproval = true;
            owner.openWorkspaceSyncAddMachine(source(), vi.fn());
            const modal = await renderOpenedModal();
            await chooseTarget(modal.screen);
            await vi.waitFor(() => expect(useExisting(modal.screen)).toMatchObject({ disabled: true, subtitle: unavailable }));
            expect(destinationMenu(modal.screen).props.selectedId).toBe('materialize_from_source_workspace');
            await vi.waitFor(() => expect(modal.submit().props.disabled).toBe(false));
            await act(async () => { modal.submit().props.onPress(); });
            await vi.waitFor(() => expect(confirmModal).toHaveBeenCalledOnce());
            expect(storedApproval().actionArgs).toMatchObject({ targetPath: '/target', destinationIntent: 'materialize_from_source_workspace' });
        });

        it('keeps Use existing folder for a non-empty folder', async () => {
            owner.openWorkspaceSyncAddMachine(source(), vi.fn());
            const modal = await renderOpenedModal();
            await chooseTarget(modal.screen);
            await vi.waitFor(() => expect(modal.submit().props.disabled).toBe(false));
            expect(useExisting(modal.screen).disabled).toBeFalsy();
            expect(destinationMenu(modal.screen).props.selectedId).toBe('use_existing');
        });

        it('keeps Use existing folder for an empty folder when the link is not a Git selection', async () => {
            targetFolder = 'empty';
            owner.openWorkspaceSyncAddMachine(source(), vi.fn());
            const modal = await renderOpenedModal();
            await chooseTarget(modal.screen);
            await vi.waitFor(() => expect(useExisting(modal.screen).disabled).toBe(true));
            const advanced = modal.screen.findAll(node => node.props.title === 'settingsSession.handoff.advanced.title'
                && typeof node.props.onPress === 'function')[0]!;
            await pressTestInstanceAsync(advanced, 'show advanced workspace policy');
            const content = modal.screen.findAllByType(DropdownMenu).find(node => node.props.itemTrigger?.title === 'settingsSession.handoff.contentSelection.title')!;
            await act(async () => invokeTestInstanceHandler(content, 'onSelect', 'all_files'));
            await vi.waitFor(() => expect(useExisting(modal.screen).disabled).toBeFalsy());
            expect(destinationMenu(modal.screen).props.selectedId).toBe('use_existing');
        });
    });

    it('says a typed daemon refusal of the link in product words, not the daemon message', async () => {
        confirmModal.mockResolvedValueOnce(true);
        const modal = await startAddMachineLink();
        await act(async () => {
            pendingCreate.resolve({ error: 'Workspace sync relationship is not ready', errorCode: 'relationship_not_ready' });
        });
        await vi.waitFor(() => expect(modal.screen.getTextContent()).toContain('workspaceSync.error.needsAttention'));
        expect(modal.screen.getTextContent()).not.toContain('Workspace sync relationship is not ready');
        // One status line, in the failure tone and announced as an alert.
        expect(statusLine(modal.screen)?.props).toMatchObject({ kind: 'error', accessibilitySemantics: 'alert' });
    });

    it('stays quiet when the person declines the Action approval: nothing ran, nothing failed', async () => {
        owner.openWorkspaceSyncAddMachine(source(), vi.fn());
        const modal = await renderOpenedModal();
        await chooseTarget(modal.screen);
        await vi.waitFor(() => expect(modal.submit().props.disabled).toBe(false));
        await act(async () => { modal.submit().props.onPress(); });
        await vi.waitFor(() => expect(confirmModal).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(modal.submit().props.disabled).toBe(false));
        expect(statusLine(modal.screen)).toBeUndefined();
        expect(modal.screen.getTextContent()).not.toContain('approval_canceled');
        expect(callsFor(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE)).toEqual([]);
    });

    it('keeps an acknowledged committed result visible when the modal is dismissed', async () => {
        confirmModal.mockResolvedValueOnce(true);
        const modal = await startAddMachineLink();
        await act(async () => { pendingCreate.resolve(committedLink()); });
        await vi.waitFor(() => expect(modal.screen.getTextContent()).toContain('workspaceSync.state.watching'));
        expect(statusLine(modal.screen)?.props).toMatchObject({ kind: 'success', accessibilitySemantics: 'status' });
        expect(modal.config.onDismissRequest('shared')).toBe(true);
        expect(modal.onClose).not.toHaveBeenCalled();
    });

    it('keeps an in-flight link visible and requires inspection when cancellation wins before a late committed reply', async () => {
        confirmModal.mockResolvedValueOnce(true);
        const modal = await startAddMachineLink();
        expect(modal.config.onDismissRequest('action')).toBe(false);
        expect(modal.onClose).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(callsFor(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE)[0]?.signal.aborted).toBe(true));
        await act(async () => { pendingCreate.resolve(committedLink()); });
        await vi.waitFor(() => expect(modal.screen.getTextContent()).toContain('workspaceSync.error.needsAttention'));
        expect(modal.screen.getTextContent()).not.toContain('workspaceSync.state.watching');
        expect(confirmModal).toHaveBeenCalledOnce();
    });

    it('does not create or open approval after cancellation wins destination admission', async () => {
        holdPreflight = true;
        const modal = await startAddMachineLink({ waitFor: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT });
        expect(modal.config.onDismissRequest('shared')).toBe(false);
        const preflight = callsFor(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT)[0]!;
        await act(async () => { pendingPreflight.resolve(targetApproval(preflight)); });
        await vi.waitFor(() => expect(modal.screen.getTextContent()).toContain('workspaceSync.error.needsAttention'));
        expect(confirmModal).not.toHaveBeenCalled();
        expect(workspace.home.artifacts(workspace.serverId).list()).toEqual([]);
        expect(callsFor(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE)).toEqual([]);
    });

    it('uses the source Home while another Home is focused and reacts only to its Account reachability', async () => {
        const otherHome = await workspace.home.addHome({ name: 'Other Home', serverUrl: 'https://other-workspace.test', accountId: 'other-account' });
        const { recordMachineRequestFailed, recordMachineRequestSucceeded } = await import('@/sync/domains/machines/reachability/machineReachability');
        recordMachineRequestFailed({ serverId: otherHome, accountId: 'other-account', machineId: 'machine-b' });
        owner.openWorkspaceSyncAddMachine(source(), vi.fn());
        const modal = await renderOpenedModal();
        const menu = () => modal.screen.findByType(MachineSelector).findByType(DropdownMenu);
        await vi.waitFor(() => expect(menu().props.items.find((item: { id: string }) => item.id === 'machine-b')?.disabled).toBe(false));
        await chooseTarget(modal.screen);
        await vi.waitFor(() => expect(modal.submit().props.disabled).toBe(false));
        await act(async () => { recordMachineRequestFailed({ serverId: workspace.serverId, accountId: 'other-account', machineId: 'machine-b' }); });
        expect(modal.submit().props.disabled).toBe(false);
        await act(async () => { recordMachineRequestFailed({ serverId: workspace.serverId, accountId: workspace.accountId, machineId: 'machine-b' }); });
        expect(modal.submit().props.disabled).toBe(true);
        await act(async () => { modal.submit().props.onPress(); });
        expect(callsFor(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT)).toEqual([]);
        await act(async () => { recordMachineRequestSucceeded({ serverId: workspace.serverId, accountId: workspace.accountId, machineId: 'machine-b' }); });
        expect(modal.submit().props.disabled).toBe(false);
    });

    describe('same-Machine destination', () => {
        const blocked = 'workspaceSync.start.blocked.destinationFolder';
        const chooseOwnMachine = async (path: string) => {
            owner.openWorkspaceSyncAddMachine(source(), vi.fn());
            const modal = await renderOpenedModal();
            await chooseTarget(modal.screen, path, 'machine-a');
            return modal;
        };

        it('lists the source Machine, labelled as this machine', async () => {
            owner.openWorkspaceSyncAddMachine(source(), vi.fn());
            const modal = await renderOpenedModal();
            const items: ReadonlyArray<{ id: string; subtitle?: string }> = modal.screen.findByType(MachineSelector).findByType(DropdownMenu).props.items;
            expect(items.find(item => item.id === 'machine-a')?.subtitle).toContain('workspaceSync.addMachine.thisMachine');
            expect(items.find(item => item.id === 'machine-b')?.subtitle ?? '').not.toContain('workspaceSync.addMachine.thisMachine');
        });

        it.each(['/source', '/source/', '/source//nested', '\\source\\nested'])('blocks %s as equal to the source root or inside it', async (path) => {
            const modal = await chooseOwnMachine(path);
            expect(modal.submit().props).toMatchObject({ disabled: true, accessibilityHint: blocked });
        });

        it('creates the link on the same Machine for a distinct sibling folder', async () => {
            requireApproval = true;
            const modal = await chooseOwnMachine('/source-copy');
            await vi.waitFor(() => expect(modal.submit().props.disabled).toBe(false));
            await act(async () => { modal.submit().props.onPress(); });
            await vi.waitFor(() => expect(confirmModal).toHaveBeenCalledOnce());
            expect(storedApproval().actionArgs).toMatchObject({ sourceWorkspaceRefId: source().id, targetMachineId: 'machine-a', targetPath: '/source-copy' });
        });
    });

    describe('refusing to attach the source checkout', () => {
        const attachSource = async (outcome: unknown) => {
            projectsOpenOutcome.current = outcome;
            const { id: _linked, ...unlinked } = source();
            owner.openWorkspaceSyncAddMachine(unlinked, vi.fn());
            const modal = await renderOpenedModal();
            await chooseTarget(modal.screen);
            await vi.waitFor(() => expect(modal.submit().props.disabled).toBe(false));
            await act(async () => { modal.submit().props.onPress(); });
            return modal;
        };

        it('names an unreachable source Machine instead of a generic save failure', async () => {
            const modal = await attachSource({ ok: true, result: { kind: 'refused', code: 'machine_unreachable' } });
            await vi.waitFor(() => expect(modal.screen.getTextContent()).toContain('workspaceSync.start.blocked.targetMachineOffline'));
            expect(modal.screen.getTextContent()).not.toContain('common.saveError');
            expect(callsFor(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE)).toEqual([]);
        });

        it('keeps the generic message for an Action failure without a Project Open refusal', async () => {
            const modal = await attachSource({ ok: false, errorCode: 'server_unreachable', error: 'server_unreachable' });
            await vi.waitFor(() => expect(modal.screen.getTextContent()).toContain('common.saveError'));
        });
    });

    it('retires an in-flight destination admission when its Account credential changes', async () => {
        holdPreflight = true;
        const modal = await startAddMachineLink({ waitFor: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT });
        const preflight = callsFor(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT)[0]!;
        await act(async () => { await workspace.home.switchAccount(workspace.serverId, 'replacement-account'); });
        await vi.waitFor(() => expect(preflight.signal.aborted).toBe(true));
        await act(async () => { pendingPreflight.resolve(targetApproval(preflight)); });
        await vi.waitFor(() => expect(modal.screen.getTextContent()).toContain('workspaceSync.error.needsAttention'));
        expect(confirmModal).not.toHaveBeenCalled();
        expect(callsFor(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE)).toEqual([]);
    });
});
