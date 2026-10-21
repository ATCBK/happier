import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { buildMentionRefV1 } from '@happier-dev/protocol/runtime/input/mentionRefV1';
import { formatInlineReferenceTokenV1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import type { ComposerStructuredInputMention } from './structuredInputMentions';

installAgentInputCommonModuleMocks();
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
const runtime = installSessionPaneRuntimeTestHarness({ credentials: {
    token: createAccountTokenForTests('account-a', { currentAccount: true }),
} });
const releases: (() => void)[] = [];
afterEach(() => { for (const release of releases.splice(0)) release(); });

function reference(kind: string, scheme: string, opaque: string) {
    const ref = buildMentionRefV1(scheme, opaque);
    const tokenText = formatInlineReferenceTokenV1({ label: opaque, ref });
    const mention: ComposerStructuredInputMention = { kind, ref, label: opaque, tokenText, start: 0, end: tokenText.length };
    return { mention, tokenText };
}

async function mount(referenceValue: ReturnType<typeof reference>, existingSession: boolean) {
    const { AgentInput } = await import('./AgentInput');
    const { MultiTextInput } = await import('@/components/ui/forms/MultiTextInput');
    const { WorkspaceNavigationProvider } = await import('@/components/appShell/workspace/WorkspaceNavigationContext');
    const { createWorkspaceState, reduceWorkspaceState } = await import('@/components/appShell/workspace/workspaceState');
    const { createWorkspaceNavigationAdapter } = await import('@/components/appShell/workspace/workspaceNavigationAdapter');
    const { createWorkspaceActionAdapter } = await import('@/components/appShell/workspace/workspaceActions');
    const { registerMountedWorkspaceAction } = await import('@/components/appShell/workspace/workspaceActionRuntime');
    const { resolveCompactAppDestinations } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
    let state = createWorkspaceState({ id: 'composer', target: { kind: 'session', params: { id: 's1', serverId: runtime.serverId } }, pinned: true, preview: false });
    const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: true, workflows: false, friends: false } });
    let nextId = 0;
    const hrefs: string[] = [];
    const dispatch = (action: Parameters<typeof reduceWorkspaceState>[1]) => { state = reduceWorkspaceState(state, action); };
    const navigation = createWorkspaceNavigationAdapter({ getState: () => state, getCatalog: () => catalog, dispatch,
        createId: () => `opened-${++nextId}`, onChange: () => {}, transport: { commit: href => { hrefs.push(href); } } });
    const execute = createWorkspaceActionAdapter({ getState: () => state, navigation, readCanvas: () => null, createId: () => `opened-${++nextId}` });
    releases.push(registerMountedWorkspaceAction(async request => execute(request.actionId, request.input)));
    const screen = await renderScreen(<WorkspaceNavigationProvider value={{ active: true, state, catalog,
        canGoBack: false, canGoForward: false, openHref: navigation.openHref, activateTab: navigation.activateTab,
        closeTab: navigation.closeTab, closeTabs: navigation.closeTabs, dispatch,
        navigationForTab: () => { throw new Error('No destination router is mounted in this fixture'); },
        registerBackStep: () => () => {}, back: () => navigation.step(-1), forward: () => navigation.step(1) }}>
        <AgentInput value={referenceValue.tokenText} onChangeText={() => {}} placeholder="Message" onSend={() => {}}
            autocompleteKinds={[]} autocompleteSuggestions={async () => []} structuredInputMentions={[referenceValue.mention]}
            composerFileScope={{ serverId: runtime.serverId, machineId: 'm1', rootPath: 'C:\\repo' }}
            {...(existingSession ? { sessionId: 's1', sessionAddress: { serverId: runtime.serverId, sessionId: 's1' } } : {})} />
    </WorkspaceNavigationProvider>, { wrapper: runtime.Wrapper });
    return { screen, chip: () => screen.findByType(MultiTextInput).props.references![0]!, state: () => state, hrefs };
}

it('opens a Session chip through the exact Home owner and fences its retained callback after Account change', async () => {
    const fixture = await mount(reference('happier.session', 'session', 'target-session'), true);
    const open = fixture.chip().onOpen;
    expect(open).toBeTypeOf('function');
    await act(async () => { open?.(); });
    expect(Object.values(fixture.state().tabs)).toContainEqual(expect.objectContaining({ target: expect.objectContaining({
        kind: 'session', params: expect.objectContaining({ id: 'target-session', serverId: runtime.serverId }),
    }) }));
    const before = [...fixture.hrefs];
    await runtime.restoreRealm({ accountId: 'another-account' });
    await act(async () => { open?.(); });
    expect(fixture.hrefs).toEqual(before);
});

it('opens a Session file through the real preview Action and normalizes Windows separators', async () => {
    const fixture = await mount(reference('happier.file', 'file', 'src\\file.ts'), true);
    expect(fixture.chip().onOpen).toBeTypeOf('function');
    await act(async () => { fixture.chip().onOpen?.(); });
    await vi.waitFor(() => expect(Object.values(fixture.state().tabs)).toContainEqual(expect.objectContaining({
        target: expect.objectContaining({ kind: 'session', params: expect.objectContaining({
            id: 's1', serverId: runtime.serverId, path: 'src/file.ts', details: 'file', fileOpenAs: 'preview',
        }) }),
    })));
});

it('resolves an admitted Project only when a machine-folder file chip is opened and refuses ambiguous authority', async () => {
    const fixture = await mount(reference('happier.file', 'file', 'src/file.ts'), false);
    const { storage } = await import('@/sync/domains/state/storage');
    const open = fixture.chip().onOpen;
    expect(open).toBeTypeOf('function');
    const ref = { id: 'accepted-project', serverId: runtime.serverId, machineId: 'm1', rootPath: 'C:/repo', label: null, createdAtMs: 0, lastOpenedAtMs: null };
    applyProjectAccountRowsFixture(storage, { workspaceRefs: [ref] });
    await act(async () => { open?.(); });
    await vi.waitFor(() => expect(Object.values(fixture.state().tabs)).toContainEqual(expect.objectContaining({
        preview: true, target: expect.objectContaining({ kind: 'project', params: expect.objectContaining({
            workspaceRefId: ref.id, serverId: runtime.serverId, initialFile: 'src/file.ts',
        }) }),
    })));
    const before = fixture.state();
    applyProjectAccountRowsFixture(storage, { workspaceRefs: [ref, { ...ref, id: 'ambiguous-project' }] });
    await act(async () => { open?.(); });
    expect(fixture.state()).toBe(before);
});

it('does not reinterpret mismatched identities or a known directory as a file preview', async () => {
    const mismatch = await mount(reference('happier.workflow', 'session', 'not-a-session'), true);
    expect(mismatch.chip().onOpen).toBeUndefined();
    await mismatch.screen.unmount();
    const directory = await mount(reference('happier.file', 'file', 'src/'), true);
    expect(directory.chip().onOpen).toBeUndefined();
});
