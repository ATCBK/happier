import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { authoringMemoryDefaults } from '@/sync/store/domains/authoringMemory';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { getActionSpec, type WorkflowDefinitionGetResultV1 } from '@happier-dev/protocol';
import { createWorkflowDefinitionFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';

/**
 * The saved-row entry intents, consumed at the one editor owner.
 *
 * Edit, Run now and Schedule arrive through the same route because only this
 * page has the reviewed Machine, the page-level Run as choice and the declared
 * inputs. Run opens the reviewed composer; Schedule opens this page's settings.
 * Both use the real page command gate on the hydrated revision; Edit opens neither.
 */

let restoreWebGlobals: (() => void) | undefined;
let previousAppliedSnapshot = getAppliedActiveServerSnapshot();
let previousRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();

const routerMock = vi.hoisted(() => ({ value: null as { spies: { push: ReturnType<typeof vi.fn> } } | null }));
const machineRpc = vi.hoisted(() => vi.fn(async (_request: Readonly<{ method: string; payload?: unknown }>) => {
    throw new Error('Machine capability RPC unavailable in this fixture');
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }) });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const mock = createExpoRouterMock();
    routerMock.value = mock;
    return mock.module;
});
vi.mock('expo-crypto', async () => ({ randomUUID: (await import('node:crypto')).randomUUID }));
// The DOM menu SDK is outside the native renderer; Modal state stays real.
vi.mock('@/utils/web/radixCjs', async () =>
    (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
// Leave detached-support decisions real; only its machine RPC is unavailable.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc')>(),
    machineRpcWithServerScope: machineRpc,
}));
// React Test Renderer has no DOM anchor or portal; render the real popover's
// content inline rather than replacing its Workflow command/composer owners.
vi.mock('@/components/ui/popover', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal,
        { maxHeight: 800, maxWidth: 520, placement: 'bottom' }));

// The actual Account Action, Artifact codec, editor and Run controller execute
// below HTTP, credential persistence, navigation and native rendering boundaries.
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);
const { storage } = await import('@/sync/domains/state/storageStore');
const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { WorkflowRunComposer } = await import('../run/WorkflowRunComposer');
const { ModalProvider, useModal } = await import('@/modal/ModalProvider');
const { createWorkflowDefinition } = await import('@/sync/domains/workflows/workflowDefinitionActions');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const DEFINITION_ID = '00000000-0000-4000-8000-000000000301';
const SECOND_DEFINITION_ID = '00000000-0000-4000-8000-000000000302';
let serverId: string;
let modals: ReturnType<typeof useModal>['state']['modals'] = [];
function ObserveModals() { modals = useModal().state.modals; return null; }
function visibleModals() { return modals.filter(modal => 'visible' in modal && modal.visible === true); }
function settingsModal() {
    return visibleModals().find((modal): modal is Extract<(typeof modals)[number], { type: 'custom' }> =>
        modal.type === 'custom' && modal.chrome?.testID === 'workflow-editor-settings-modal');
}

function expectNoWorkflowWrites(): void {
    expect(home.requests.filter(request => (request.path.startsWith('/v1/artifacts')
        || request.path.startsWith('/v3/automations')) && request.input !== null)).toEqual([]);
    expect(machineRpc.mock.calls.filter(([request]) => request.method === getActionSpec('workflow.run.start').bindings?.rpcMethod)).toEqual([]);
}

/** A saved revision the canonical validator accepts, with one declared input. */
function savedDefinition(): WorkflowDefinitionGetResultV1 {
    return {
        definitionId: DEFINITION_ID,
        access: 'owner',
        revision: { headerVersion: 1, bodyVersion: 2 },
        metadata: { title: 'Release check' },
        definition: createWorkflowDefinitionFixture({
            inputs: [{ name: 'topic', valueType: 'string', required: true }],
            defaults: {
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
            },
            blocks: [{
                kind: 'step',
                id: 'review',
                document: { text: 'Review the release', references: [], attachments: [] },
                input: [],
                result: { kind: 'text' },
            }],
        }),
    };
}

function pushSpy(): ReturnType<typeof vi.fn> {
    const spy = routerMock.value?.spies.push;
    if (!spy) throw new Error('Expected the router mock to expose its push spy');
    return spy;
}

function EditorPaneWrapper({ children }: React.PropsWithChildren) {
    return <AppPaneProvider><ModalProvider><ObserveModals />{children}</ModalProvider></AppPaneProvider>;
}

beforeEach(async () => {
    previousAppliedSnapshot = getAppliedActiveServerSnapshot();
    previousRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();
    await home.reset();
    serverId = await home.addHome({ name: 'Editor entries', serverUrl: 'https://editor-entries.test', accountId: 'account-a' });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    restoreWebGlobals = withPopoverWebGlobals();
    // Account lifetime is internal owner state, not a mockable boundary. In
    // particular, manufacturing a fresh lifetime per snapshot loops React's
    // external-store subscription before any entry-intent assertion can run.
    storage.setState({ profileScope: { serverId, accountId: 'account-a' },
        settingsScope: { serverId, accountId: 'account-a' }, isDataReady: true, isSessionDraftsReady: true,
        settings: settingsDefaults,
        authoringMemory: { ...authoringMemoryDefaults, recentMachinePaths: [{ machineId: 'machine-1', path: '/repo/project' }] },
        machines: { 'machine-1': createMachineFixture({ id: 'machine-1' }) }, machineListByServerId: {} });
    modals = [];
    machineRpc.mockClear();
    home.answer(serverId, '/v3/automations', { body: { automations: [], nextCursor: null } });
    const saved = savedDefinition();
    await createWorkflowDefinition({ definitionId: saved.definitionId, definition: saved.definition, metadata: saved.metadata });
    home.requests.splice(0);
    routerMock.value?.spies.push.mockClear();
});

afterEach(async () => {
    await standardCleanup();
    await home.reset();
    publishAppliedActiveServerSnapshot(previousAppliedSnapshot, previousRuntimeAvailable);
    restoreWebGlobals?.();
});

describe('WorkflowEditorHostScreen saved-entry intents', () => {
    it('inserts an example into the current draft as one undoable change without saving or running', async () => {
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new' }} />, { wrapper: EditorPaneWrapper });
        await screen.pressByTestIdAsync('workflow-editor-add-root-examples');
        await screen.pressByTestIdAsync('workflow-examples:morning-digest:use');
        expect(screen.findByTestId('workflow-editor-name')?.props.value).toBe('workflows.examples.morningDigest.title');
        expect(screen.findByTestId('workflow-editor-step-digest')).not.toBeNull();
        await screen.pressByTestIdAsync('workflow-editor-undo');
        expect(screen.findByTestId('workflow-editor-name')?.props.value).toBe('');
        expect(screen.findByTestId('workflow-editor-step-digest')).toBeNull();
        expectNoWorkflowWrites();
    });
    it('opens a catalog example as an unsaved draft and keeps edits across rerenders', async () => {
        const { WORKFLOW_STARTER_EXAMPLES_V1 } = await import('@happier-dev/protocol');
        const example = WORKFLOW_STARTER_EXAMPLES_V1.find((entry) => entry.key === 'morning-digest')!;
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'new', exampleKey: example.key }} />,
            { wrapper: EditorPaneWrapper });
        expect(screen.findByTestId('workflow-editor-name')?.props.value).toBe(example.titleKey);
        expectNoWorkflowWrites();
        await act(async () => { screen.changeTextByTestId('workflow-editor-name', 'My morning digest'); });
        await screen.update(<WorkflowEditorHostScreen source={{ kind: 'new', exampleKey: example.key }} />);
        expect(screen.findByTestId('workflow-editor-name')?.props.value).toBe('My morning digest');
    });
    it('opens the definition and triggers nothing when the entry was Edit', async () => {
        const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
        const screen = await renderScreen(<WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: DEFINITION_ID }} />, { wrapper: EditorPaneWrapper });
        await act(async () => {});

        expect(screen.findByTestId('workflow-editor-name')?.props.value).toBe('Release check');
        expect(visibleModals()).toHaveLength(0);
        expect(pushSpy()).not.toHaveBeenCalled();
        expectNoWorkflowWrites();
    });

    it('collects declared inputs through the Run-now owner for a Run intent', async () => {
        const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
        const screen = await renderScreen(
            <WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: DEFINITION_ID, intent: 'run' }} />,
            { wrapper: EditorPaneWrapper },
        );
        await act(async () => {});

        // The reviewed revision is what the person sees and runs; the intent does
        // not replace the hydrated draft with a fresh one.
        expect(screen.findByTestId('workflow-editor-name')?.props.value).toBe('Release check');
        const composers = screen.findAllByType(WorkflowRunComposer);
        expect(composers).toHaveLength(1);
        expect(composers[0]?.props.inputs).toMatchObject([{ name: 'topic', required: true }]);
        // A required declared input is blocking, so nothing is admitted yet and
        // no Automation is written.
        expectNoWorkflowWrites();
        expect(pushSpy()).not.toHaveBeenCalled();
    });

    it('opens the page settings for a Schedule intent without creating an Automation', async () => {
        const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
        const source = { kind: 'saved', definitionId: DEFINITION_ID, intent: 'schedule' } as const;
        const screen = await renderScreen(<WorkflowEditorHostScreen source={source} />, { wrapper: EditorPaneWrapper });
        await act(async () => {});

        expect(pushSpy()).not.toHaveBeenCalled();
        expect(settingsModal()).toBeDefined();
        expectNoWorkflowWrites();

        // A rerender of the same logical source is not a second Schedule.
        await screen.update(<WorkflowEditorHostScreen source={{ ...source }} />);
        await act(async () => {});
        expect(pushSpy()).not.toHaveBeenCalled();
    });

    it('consumes a new saved-row intent when the same mounted route changes definition', async () => {
        const { WorkflowEditorHostScreen } = await import('./WorkflowEditorHostScreen');
        const screen = await renderScreen(
            <WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: DEFINITION_ID, intent: 'schedule' }} />,
            { wrapper: EditorPaneWrapper },
        );
        await act(async () => {});
        expect(settingsModal()).toBeDefined();
        await screen.pressByTestIdAsync('modal-card-close');
        expect(settingsModal()).toBeUndefined();

        await createWorkflowDefinition({ definitionId: SECOND_DEFINITION_ID, definition: savedDefinition().definition,
            metadata: { title: 'Second release check' } });
        await screen.update(
            <WorkflowEditorHostScreen source={{ kind: 'saved', definitionId: SECOND_DEFINITION_ID, intent: 'schedule' }} />,
        );
        await act(async () => {});

        // A route rerender is not another press, but a different definition is
        // a distinct row action and must reach the Schedule owner once.
        expect(screen.findByTestId('workflow-editor-name')?.props.value).toBe('Second release check');
        expect(settingsModal()).toBeDefined();
        expect(pushSpy()).not.toHaveBeenCalled();
    });
});
