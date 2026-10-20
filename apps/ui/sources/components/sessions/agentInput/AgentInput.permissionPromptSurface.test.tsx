import React from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { renderWithSessionTranscriptSource as renderScreen } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const layoutMockState = vi.hoisted(() => ({
    platform: 'ios' as 'ios' | 'web',
}));

vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('Image', props, null),
}));

vi.mock('react-native', async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('View', props, props.children),
            Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('Text', props, props.children),
            Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('Pressable', props, props.children),
            ScrollView: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('ScrollView', props, props.children),
            ActivityIndicator: (props: Record<string, unknown>) =>
                React.createElement('ActivityIndicator', props, null),
            Platform: {
                get OS() {
                    return layoutMockState.platform;
                },
                select: (v: any) => v?.[layoutMockState.platform] ?? v?.default ?? v?.ios,
            },
            useWindowDimensions: () => ({ width: 800, height: 600 }),
            Dimensions: {
                get: () => ({ width: 800, height: 600, scale: 1, fontScale: 1 }),
            },
        });
});
vi.mock('react-native-unistyles', async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
});
vi.mock('@expo/vector-icons', () => ({
        Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props, null),
        Octicons: (props: Record<string, unknown>) => React.createElement('Octicons', props, null),
}));
vi.mock('@/text', async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
});
vi.mock('react-native-reanimated', async () => (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock());
vi.mock('react-native-keyboard-controller', () => ({ useFocusedInputHandler: () => {} }));

vi.mock('@/components/tools/shell/permissions/PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

vi.mock('@/components/tools/shell/permissions/PermissionPromptCard', () => ({
    PermissionPromptCard: (props: any) => React.createElement('PermissionPromptCard', props),
}));
vi.mock('@/components/tools/shell/approvals/ApprovalPromptCard', () => ({
    ApprovalPromptCard: (props: any) => React.createElement('ApprovalPromptCard', props),
}));
vi.mock('@/components/tools/shell/userActions/UserActionPromptCard', () => ({
    UserActionPromptCard: (props: any) => React.createElement('UserActionPromptCard', props),
}));

vi.mock('@/components/ui/forms/MultiTextInput', () => ({
    MultiTextInput: (props: Record<string, unknown>) => React.createElement('MultiTextInput', props, null),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: Record<string, unknown>) => React.createElement('Switch', props, null),
}));

vi.mock('@/components/ui/theme/haptics', () => ({
    hapticsLight: () => {},
    hapticsError: () => {},
}));

vi.mock('@/components/ui/feedback/Shaker', () => ({
    Shaker: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: () => null,
}));

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: (props: any) => React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/ui/popover', async (importOriginal) => {
    const { createInlinePopoverModuleMock } = await import('@/dev/testkit/mocks/popover');
    return createInlinePopoverModuleMock(importOriginal);
});

vi.mock('@/components/ui/scroll/ScrollEdgeFades', () => ({
    ScrollEdgeFades: (props: any) => React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/ui/scroll/ScrollEdgeIndicators', () => ({
    ScrollEdgeIndicators: (props: any) => React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/ui/buttons/PrimaryCircleIconButton', () => ({
    PrimaryCircleIconButton: () => null,
}));

vi.mock('@/components/ui/lists/ActionListSection', () => ({
    ActionListSection: () => null,
}));

vi.mock('@/components/sessions/pickers/OptionPickerOverlay', () => ({
    OptionPickerOverlay: () => null,
}));

vi.mock('./ResumeChip', () => ({
    ResumeChip: () => null,
    formatResumeChipLabel: () => '',
    RESUME_CHIP_ICON_NAME: 'play',
    RESUME_CHIP_ICON_SIZE: 16,
}));

vi.mock('./PathAndResumeRow', () => ({
    PathAndResumeRow: () => null,
}));

vi.mock('@/hooks/ui/useKeyboardHeight', () => ({
    useKeyboardHeight: () => 0,
}));

vi.mock('./components/PermissionModePicker', () => ({
    PermissionModePicker: () => null,
}));

vi.mock('./attachActionBarMouseDragScroll', () => ({
    attachActionBarMouseDragScroll: () => () => {},
}));

const browser = await installBrowserRuntimeForTests({ url: 'https://composer-permissions.test/' });
afterAll(() => browser.restore());
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { getStorage } = await import('@/sync/domains/state/storageStore');
const initialStorageState = getStorage().getState();

function setPermissionPromptSurface(permissionPromptSurface: 'composer' | 'transcript') {
    getStorage().setState({ settings: { ...getStorage().getState().settings, permissionPromptSurface } });
}

afterEach(async () => {
    getStorage().setState(initialStorageState, true);
    await home.reset();
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((merged, entry) => ({
            ...merged,
            ...flattenStyle(entry),
        }), {});
    }
    if (typeof style === 'object') {
        return style as Record<string, unknown>;
    }
    return {};
}

function hasAncestor(node: { parent?: unknown } | null | undefined, ancestor: unknown): boolean {
    let current = node?.parent;
    while (current) {
        if (current === ancestor) return true;
        current = (current as { parent?: unknown }).parent;
    }
    return false;
}

describe('AgentInput (permission prompt surface)', () => {
    beforeEach(() => {
        layoutMockState.platform = 'ios';
        getStorage().setState({ settings: {
            ...initialStorageState.settings,
            agentInputEnterToSend: true,
            agentInputHistoryScope: 'perSession',
            agentInputActionBarLayout: 'wrap',
            agentInputChipDensity: 'labels',
            sessionPermissionModeApplyTiming: 'immediate',
            permissionPromptSurface: 'composer',
        } });
    });

    it('hides permission cards when surface is transcript', async () => {
        setPermissionPromptSurface('transcript');
        const { AgentInput } = await import('./AgentInput');
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<AgentInput
                    placeholder="x"
                    value=""
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                    sessionId="s1"
                    permissionRequests={[{ id: 'p1', tool: 'Bash', arguments: { command: 'ls' }, createdAt: 1 } as any]}
                    connectionStatus={null as any}
                />)).tree;

        expect(tree.findAllByType('PermissionPromptCard' as any)).toHaveLength(0);
        act(() => tree.unmount());
    });

    it('shows permission cards when surface is composer', async () => {
        setPermissionPromptSurface('composer');
        const { AgentInput } = await import('./AgentInput');
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<AgentInput
                    placeholder="x"
                    value=""
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                    sessionId="s1"
                    permissionRequests={[{ id: 'p1', tool: 'Bash', arguments: { command: 'ls' }, createdAt: 1 } as any]}
                    connectionStatus={null as any}
                />)).tree;

        expect(tree.findAllByType('PermissionPromptCard' as any)).toHaveLength(1);
        act(() => tree.unmount());
    });

    it('keeps composer permission chrome fixed above the web input scroll area', async () => {
        layoutMockState.platform = 'web';
        setPermissionPromptSurface('composer');
        const { AgentInput } = await import('./AgentInput');
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<AgentInput
                    placeholder="x"
                    value=""
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                    sessionId="s1"
                    permissionRequests={[{ id: 'p1', tool: 'Bash', arguments: { command: 'ls' }, createdAt: 1 } as any]}
                    connectionStatus={null as any}
                />)).tree;

        const scrollViews = tree.root.findAll((node: any) => node.type === 'ScrollView');
        const composerVariableScroll = scrollViews.find((node: any) => (
            node.props.testID !== 'agentInput.permissionRequests.scroll'
            && flattenStyle(node.props.style).marginHorizontal === -8
        ));
        expect(composerVariableScroll).toBeTruthy();
        expect(flattenStyle(composerVariableScroll?.props.contentContainerStyle).paddingHorizontal).toBe(8);

        const permissionChrome = tree.root.findByProps({ testID: 'agentInput.permissionRequests.chrome' });
        expect(hasAncestor(permissionChrome, composerVariableScroll)).toBe(false);
        expect(flattenStyle(permissionChrome.parent?.props.style).marginHorizontal).toBe(-8);
        act(() => tree.unmount());
    });

    it('does not show user action cards in the composer when surface is composer', async () => {
        setPermissionPromptSurface('composer');
        const { AgentInput } = await import('./AgentInput');
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<AgentInput
                    placeholder="x"
                    value=""
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                    sessionId="s1"
                    {...({ userActionRequests: [{ id: 'q1', tool: 'AskUserQuestion', kind: 'user_action', arguments: { questions: [{ header: 'Mode', question: 'Create?', options: [{ label: 'Yes', description: 'Create it' }], multiSelect: false }] }, createdAt: 1 }] } as any)}
                    connectionStatus={null as any}
                />)).tree;

        expect(tree.findAllByType('UserActionPromptCard' as any)).toHaveLength(0);
        expect(tree.root.findAllByProps({ testID: 'agentInput.permissionRequests.chrome' })).toHaveLength(0);
        act(() => tree.unmount());
    });

    it('does not show user action cards in the composer when surface is transcript', async () => {
        setPermissionPromptSurface('transcript');
        const { AgentInput } = await import('./AgentInput');
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<AgentInput
                    placeholder="x"
                    value=""
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                    sessionId="s1"
                    {...({ userActionRequests: [{ id: 'q1', tool: 'AskUserQuestion', kind: 'user_action', arguments: { questions: [{ header: 'Mode', question: 'Create?', options: [{ label: 'Yes', description: 'Create it' }], multiSelect: false }] }, createdAt: 1 }] } as any)}
                    connectionStatus={null as any}
                />)).tree;

        expect(tree.findAllByType('UserActionPromptCard' as any)).toHaveLength(0);
        expect(tree.root.findAllByProps({ testID: 'agentInput.permissionRequests.chrome' })).toHaveLength(0);
        act(() => tree.unmount());
    });

    it('does not show user action cards for legacy requests without an explicit kind', async () => {
        setPermissionPromptSurface('composer');
        const { AgentInput } = await import('./AgentInput');
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<AgentInput
                    placeholder="x"
                    value=""
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                    sessionId="s1"
                    {...({ userActionRequests: [{ id: 'q1', tool: 'AskUserQuestion', arguments: { questions: [{ header: 'Mode', question: 'Create?', options: [{ label: 'Yes', description: 'Create it' }], multiSelect: false }] }, createdAt: 1 }] } as any)}
                    connectionStatus={null as any}
                />)).tree;

        expect(tree.findAllByType('UserActionPromptCard' as any)).toHaveLength(0);
        act(() => tree.unmount());
    });
});
