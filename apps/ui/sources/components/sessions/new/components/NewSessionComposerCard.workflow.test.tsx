import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createNewSessionPromptStore } from '../hooks/screenModel/newSessionPromptStore';
import { NewSessionComposerCard } from './NewSessionComposerCard';
import type { NewSessionSimplePanelProps } from './NewSessionSimplePanel';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { useNewSessionWorkflowStart } from '../hooks/useNewSessionWorkflowStart';
import { getStorage } from '@/sync/domains/state/storageStore';
import { act } from 'react-test-renderer';
import { createMachineFixture, flattenTestStyle } from '@/dev/testkit';
import Color from 'color';
import { activateStorageAccountScope } from '@/dev/testkit/mocks/storage';
import { GlassRuntimeEnvironmentProvider } from '@/components/ui/glass/glassRuntimeEnvironment';
import { reportPopoverContentLayout, withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { OverlayPortalHost, OverlayPortalProvider } from '@/components/ui/popover/OverlayPortal';

const platformState = vi.hoisted(() => ({ os: 'web' as 'web' | 'android', width: 1440 }));
let activeAccountScope: Awaited<ReturnType<typeof activateStorageAccountScope>> | null = null;

beforeEach(async () => {
    activeAccountScope = await activateStorageAccountScope({ serverId: 'server-a', accountId: 'account-a' });
});
afterEach(() => {
    activeAccountScope?.dispose();
    activeAccountScope = null;
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        useWindowDimensions: () => ({ width: platformState.width, height: 844, scale: 1, fontScale: 1 }),
        Platform: {
            get OS() { return platformState.os; },
            select: (values: Record<string, unknown>) => values[platformState.os] ?? values.default,
        },
    });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => [],
}));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

function panelProps(): NewSessionSimplePanelProps {
    return {
            // Native refs begin unmounted; this fixture does not measure the popover boundary.
            popoverBoundaryRef: React.createRef() as NewSessionSimplePanelProps['popoverBoundaryRef'],
            headerHeight: 0, safeAreaTop: 0, safeAreaBottom: 0,
            newSessionTopPadding: 0, newSessionSidePadding: 0, newSessionBottomPadding: 0, containerStyle: {},
            promptStore: createNewSessionPromptStore('Keep this brief'), setSessionPrompt: () => {},
            handleCreateSession: () => {}, canCreate: true, isCreating: false,
            emptyAutocompleteKinds: [], emptyAutocompleteSuggestions: async () => [],
            agentType: 'codex', handleAgentClick: undefined, permissionMode: 'default',
            handlePermissionModeChange: undefined, modelMode: 'default', setModelMode: undefined,
            modelOptions: [], connectionStatus: undefined, machineName: undefined, selectedPath: '/repo',
            useProfiles: false, selectedProfileId: null,
            showResumePicker: false, resumeSessionId: null, isResumeSupportChecking: false,
        } satisfies NewSessionSimplePanelProps;
}

describe('New workflow entry', () => {
    it('does not observe Machine inventory while no unsettled Workflow project needs a Where label', async () => {
        const store = getStorage(), previous = store.getState();
        const props = { ...panelProps(), selectedMachineId: 'machine-1', targetServerId: 'server-a' };
        let renders = 0;
        const hook = await renderHook(() => {
            renders++;
            return useNewSessionWorkflowStart({ panelProps: props, prompt: 'Keep this brief' });
        });
        try {
            const settled = renders;
            await act(async () => store.getState().applyMachines([createMachineFixture({ id: 'unrelated-machine' })], false,
                { sourceServerId: 'server-a', sourceAccountId: 'account-a' }));
            expect(renders).toBe(settled);
            expect(hook.getCurrent().composer).toBeNull();
            // The current picker choice is not the retained request: without an unsettled request,
            // even this Machine has no Workflow Where presentation to refresh.
            await act(async () => store.getState().applyMachines([createMachineFixture({ id: 'machine-1' })], false,
                { sourceServerId: 'server-a', sourceAccountId: 'account-a' }));
            expect(renders).toBe(settled);
        } finally {
            await hook.unmount();
            store.setState(previous, true);
        }
    });
    it('names the exact Provider model on the real composer chip using picker presentation', async () => {
        const { DaemonProviderModelProjectionGroupV1Schema } = await import('@happier-dev/protocol/rpc');
        const { AgentIcon } = await import('@/agents/registry/AgentIcon');
        const ref = { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: 'pc_deepseek', modelId: 'deepseek-v4-flash' };
        const group = DaemonProviderModelProjectionGroupV1Schema.parse({
            connectionId: ref.providerConnectionId, providerName: 'DeepSeek', connectionName: 'DeepSeek',
            connectionRole: 'named', connectionDisplayNameMode: 'custom', connectionRevision: 1,
            authorization: { authorized: true }, manualModelPolicy: 'allowed', supportsFreeformModelIds: false,
            suppressedConnectedServiceIds: [], modelLoadAction: 'descriptor_absent', modelLoadPreflightPolicy: null,
            rows: [{ ref, descriptor: { id: ref.modelId, name: 'DeepSeek V4 Flash' },
                sources: { manual: false, static: true, probe: false }, confidence: 'verified_static',
                compatibility: { result: { status: 'experimental', selectedProtocol: 'anthropic-messages',
                    reasons: ['compatibility_evidence_missing'], confirmationScope: { kind: 'model', modelId: ref.modelId } },
                    compatibilityFingerprint: 'compatibility:v1:deepseek', confirmed: true },
                endpointHealth: 'available', catalog: { stale: false }, loadState: 'unknown', visibility: 'visible' }],
        });
        const props = {
            ...panelProps(), agentType: 'claude', modelMode: ref.modelId,
            agentPickerOptions: [{ id: ref.agentTargetKey, label: 'Claude', icon: <AgentIcon agentId="claude" size={20} /> }],
            modelPickerPresentation: { agentTargetKey: ref.agentTargetKey, selected: group.rows[0]!.ref, nativeModels: [],
                providerGroups: [group], hiddenNativeModelKeys: new Set<string>(), providerProjectionAuthoritative: true,
                fallbackLabel: 'Loading model', fieldLabel: 'Model' },
        };
        const screen = await renderScreen(<NewSessionComposerCard panelProps={props} layout="screen" attachments={false} />);
        expect(screen.getTextContent()).toContain('DeepSeek V4 Flash');
        expect(screen.getTextContent()).not.toContain(ref.modelId);
        expect(screen.findByTestId('agent-input-agent-chip-logo')).not.toBeNull();
        await screen.update(<NewSessionComposerCard panelProps={{ ...props, modelPickerPresentation: {
            ...props.modelPickerPresentation, providerGroups: [{ ...group, rows: [{ ...group.rows[0]!, descriptor: {
                id: ref.modelId, name: 'DeepSeek Flash renamed',
            } }] }],
        } }} layout="screen" attachments={false} />);
        expect(screen.getTextContent()).toContain('DeepSeek Flash renamed');
        await screen.update(<NewSessionComposerCard panelProps={{ ...props, modelPickerPresentation: {
            ...props.modelPickerPresentation, providerGroups: [], providerProjectionAuthoritative: false,
        } }} layout="screen" attachments={false} />);
        expect(screen.getTextContent()).toContain(ref.modelId);
        expect(screen.getTextContent()).not.toContain('Loading model');
        await screen.update(<NewSessionComposerCard panelProps={{ ...props, modelPickerPresentation: {
            ...props.modelPickerPresentation, providerGroups: [], providerProjectionAuthoritative: true,
        } }} layout="screen" attachments={false} />);
        expect(screen.getTextContent()).toContain('Loading model');
        expect(screen.getTextContent()).not.toContain(ref.modelId);
    });
    it('allows an ordinary session to submit without an optional composer document', async () => {
        const props = panelProps();
        const screen = await renderScreen(<NewSessionComposerCard panelProps={props} layout="screen" attachments={false} />);
        expect(screen.findByTestId('new-session-composer-send')?.props.disabled).toBe(false);
        await screen.update(<NewSessionComposerCard panelProps={{ ...props, canCreate: false }} layout="screen" attachments={false} />);
        expect(screen.findByTestId('new-session-composer-send')?.props.disabled).toBe(true);
    });
    it('retains the selected workflow and its inputs when the screen panel recomposes across phone width', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');
        const previous = getStorage().getState().profileScope;
        const props = { ...panelProps(), selectedMachineId: 'machine-1', targetServerId: 'server-a' };
        platformState.width = 1440;
        const restorePopoverGlobals = withPopoverWebGlobals();
        let cleanupScreen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            await act(async () => {
                getStorage().setState({ profileScope: { serverId: 'server-a', accountId: 'account-a' } });
            });
            const screen = await renderScreen(<NewSessionSimplePanel {...props} />, {
                wrapper: ({ children }) => <OverlayPortalProvider>{children}<OverlayPortalHost /></OverlayPortalProvider>,
                // Only the platform's ref measurement/focus/listener API is supplied; Popover's
                // placement, presence, dismissal and child selection remain real.
                createNodeMock: () => ({
                    measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(80, 120, 44, 44),
                    getBoundingClientRect: () => ({ x: 80, y: 120, left: 80, top: 120, width: 44, height: 44, right: 124, bottom: 164 }),
                    focus: () => {},
                    blur: () => {},
                    addEventListener: () => {},
                    removeEventListener: () => {},
                    ownerDocument: { addEventListener: () => {}, removeEventListener: () => {} },
                }),
            });
            cleanupScreen = screen;
            await screen.pressByTestIdAsync('new-session-workflow-chip');
            await act(async () => { reportPopoverContentLayout(screen.tree, { width: 420, height: 400 }); });
            await screen.pressByTestIdAsync('workflow-choice:builtin:plan-with-a-panel');
            const input = screen.findByTestId('workflow-run-inputs');
            expect(input).not.toBeNull();
            for (const width of [390, 430, 1440]) {
                platformState.width = width;
                await screen.update(<NewSessionSimplePanel {...props} />);
                expect(screen.findByTestId('workflow-run-inputs')).toBe(input);
                expect(screen.findByTestId('new-session-composer-input')?.props.value).toBe('Keep this brief');
            }
        } finally {
            await cleanupScreen?.unmount();
            restorePopoverGlobals();
            platformState.width = 1440;
            await act(async () => { getStorage().setState({ profileScope: previous }); });
        }
    });
    it('keeps the admitted read-only document on the same floating material plane', async () => {
        const { AgentInput } = await import('@/components/sessions/agentInput');
        const store = getStorage();
        const previous = store.getState().settings;
        platformState.os = 'android';
        try {
            await act(async () => {
                store.setState({ settings: { ...previous, glassBlurEnabled: true, glassSurfaceMaterials: null } });
            });
            const screen = await renderScreen(<GlassRuntimeEnvironmentProvider value={{ nativeRenderer: true }}>
                <AgentInput value="Frozen document" placeholder="Document" surfaceGroup="floating"
                    autocompleteKinds={[]} autocompleteSuggestions={async () => []} />
            </GlassRuntimeEnvironmentProvider>);
            const surface = screen.findByTestId('agent-input-material-surface');
            expect(surface).not.toBeNull();
            expect(Color(flattenTestStyle(surface?.props.style).backgroundColor as string).alpha()).toBe(0.02);
            expect(screen.getTextContent()).toContain('Frozen document');
            expect(screen.findByTestId('new-session-composer-input')).toBeNull();
        } finally {
            platformState.os = 'web';
            await act(async () => { store.setState({ settings: previous }); });
        }
    });
    it('gives the phone floating composer its own material coat and restores solid when its group is off', async () => {
        const store = getStorage();
        const previous = store.getState().settings;
        platformState.os = 'android';
        try {
            await act(async () => {
                store.setState({ settings: { ...previous, glassBlurEnabled: true, glassSurfaceMaterials: null } });
            });
            const screen = await renderScreen(<GlassRuntimeEnvironmentProvider value={{ nativeRenderer: true }}>
                <NewSessionComposerCard panelProps={panelProps()} layout="screen" attachments={false} surfaceGroup="floating" />
            </GlassRuntimeEnvironmentProvider>);
            const surface = screen.findByTestId('agent-input-material-surface');
            expect(surface).not.toBeNull();
            expect(Color(flattenTestStyle(surface?.props.style).backgroundColor as string).alpha()).toBe(0.02);
            expect(screen.findByTestId('new-session-composer-input')?.props.value).toBe('Keep this brief');
            await act(async () => {
                store.setState({ settings: { ...previous, glassBlurEnabled: false, glassSurfaceMaterials: null } });
            });
            expect(Color(flattenTestStyle(screen.findByTestId('agent-input-material-surface')?.props.style).backgroundColor as string).alpha()).toBe(1);
            await act(async () => {
                store.setState({ settings: { ...previous, glassBlurEnabled: true, glassSurfaceMaterials: null } });
                screen.tree.update(<GlassRuntimeEnvironmentProvider value={{ nativeRenderer: true }}>
                    <NewSessionComposerCard panelProps={panelProps()} layout="screen" attachments={false} />
                </GlassRuntimeEnvironmentProvider>);
            });
            expect(Color(flattenTestStyle(screen.findByTestId('agent-input-material-surface')?.props.style).backgroundColor as string).alpha()).toBe(1);
        } finally {
            platformState.os = 'web';
            await act(async () => { store.setState({ settings: previous }); });
        }
    });
    it('offers Workflow in the actual New composer without replacing the plain-session prompt', async () => {
        const screen = await renderScreen(<NewSessionComposerCard panelProps={panelProps()} layout="screen" attachments={false} />);
        expect(screen.findByTestId('new-session-workflow-chip')).not.toBeNull();
        expect(screen.findByTestId('new-session-composer-input')?.props.value).toBe('Keep this brief');
    });
    it('retains the floating material when a selected workflow replaces the phone composer', async () => {
        const store = getStorage();
        const previous = store.getState();
        platformState.os = 'android';
        try {
            await act(async () => {
                store.setState({ profileScope: { serverId: 'server-a', accountId: 'account-a' }, settings: { ...previous.settings, glassBlurEnabled: true, glassSurfaceMaterials: null } });
            });
            const props = { ...panelProps(), selectedMachineId: 'machine-1', targetServerId: 'server-a' };
            const hook = await renderHook(() => useNewSessionWorkflowStart({ panelProps: props, prompt: 'Keep this brief', surfaceGroup: 'floating' }));
            const content = hook.getCurrent().chip.collapsedContentPopover?.renderContent;
            if (typeof content !== 'function') throw new Error('Workflow picker content is missing');
            const pickerNode = content({ requestClose: () => {}, maxHeight: 420 });
            if (!React.isValidElement(pickerNode)) throw new Error('Workflow picker is missing');
            const picker = await renderScreen(pickerNode);
            await picker.pressByTestIdAsync('workflow-choice:builtin:plan-with-a-panel');
            const composer = hook.getCurrent().composer;
            if (composer === null) throw new Error('Selected workflow composer is missing');
            const screen = await renderScreen(<GlassRuntimeEnvironmentProvider value={{ nativeRenderer: true }}>
                {composer}
            </GlassRuntimeEnvironmentProvider>);
            expect(Color(flattenTestStyle(screen.findByTestId('agent-input-material-surface')?.props.style).backgroundColor as string).alpha()).toBe(0.02);
            expect(screen.findByTestId('new-session-composer-input')?.props.value).toBe('Keep this brief');
        } finally {
            platformState.os = 'web';
            await act(async () => { store.setState({ settings: previous.settings, profileScope: previous.profileScope }); });
        }
    });
    it('gives Home\'s embedded composer the same rails as the page: Workflow stays on the bar', async () => {
        const screen = await renderScreen(<NewSessionComposerCard panelProps={panelProps()} layout="embedded" attachments={false} />);
        expect(screen.findByTestId('new-session-workflow-chip')).not.toBeNull();
        expect(screen.findByTestId('new-session-composer-input')?.props.value).toBe('Keep this brief');
    });
    it('keeps typed text as the first text input, then withdraws that private draft on Account change', async () => {
        getStorage().setState({ profileScope: { serverId: 'server-a', accountId: 'account-a' } });
        const props = { ...panelProps(), selectedMachineId: 'machine-1', targetServerId: 'server-a' };
        const hook = await renderHook(() => useNewSessionWorkflowStart({ panelProps: props, prompt: 'Keep this brief' }));
        const content = hook.getCurrent().chip.collapsedContentPopover?.renderContent;
        if (typeof content !== 'function') throw new Error('Workflow picker content is missing');
        const pickerNode = content({ requestClose: () => {}, maxHeight: 420 });
        if (!React.isValidElement(pickerNode)) throw new Error('Workflow picker is missing');
        const picker = await renderScreen(pickerNode);
        await picker.pressByTestIdAsync('workflow-choice:builtin:plan-with-a-panel');
        const composer = hook.getCurrent().composer;
        if (composer === null) throw new Error('Selected workflow composer is missing');
        const screen = await renderScreen(composer);
        expect(screen.findByTestId('new-session-composer-input')?.props.value).toBe('Keep this brief');
        // No Home feature snapshot has advertised Workflow support in this fixture.
        expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(true);
        await act(async () => { getStorage().setState({ profileScope: { serverId: 'server-a', accountId: 'account-b' } }); });
        expect(hook.getCurrent().composer).toBeNull();
    });
});
