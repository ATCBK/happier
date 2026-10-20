/** @vitest-environment jsdom */
import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestSessionTranscriptSource, installBrowserStorageLockBoundary, renderWithSessionTranscriptSource, standardCleanup } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import type { WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: () => '/search' }).module);
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
// The vendor streaming renderer is not exercised by this file-reference journey.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected Markdown in reference journey'); },
}));

// Warm the real route graph outside the per-behavior deadline, as in WorkspaceTabs.seam.
const production = await (async () => {
    const restore = installBrowserStorageLockBoundary();
    installDisconnectedServerSocketBoundary();
    const homes = await serveActionHomes({ homes: [{ key: 'warm', serverUrl: 'https://transcript-import.test',
        accountId: 'alice', currentAccount: true }], route: () => undefined });
    let disconnect: (() => Promise<unknown>) | undefined;
    try {
        disconnect = await homes.restoreActiveConnection();
        return await Promise.all([
            import('@/components/appShell/workspace/WorkspaceProvider'), import('@/components/appShell/panes/AppPaneProvider'),
            import('@/components/appShell/destinations/compactAppDestinationCatalog'), import('./StructuredReferencesRow'), import('@/sync/domains/state/storage'),
            import('../useTranscriptFileLinks'),
            import('@/components/sessions/files/turnChanges/TranscriptTurnChangesCard'), import('@/scm/scmStatusFiles'),
            import('@/utils/ui/toTestIdSafeValue'),
        ]);
    } finally { try { await disconnect?.(); } finally { await homes.dispose(); restore(); } }
})();

let disposeHome: (() => Promise<void>) | undefined;
let disconnectHome: (() => Promise<unknown>) | undefined;
let restoreLocks: (() => void) | undefined;
afterEach(async () => {
    standardCleanup();
    try { await disconnectHome?.(); }
    finally { await disposeHome?.(); restoreLocks?.(); }
});

it('opens a transcript file through the canonical Action into the qualified session destination', async () => {
    restoreLocks = installBrowserStorageLockBoundary();
    installDisconnectedServerSocketBoundary();
    const homes = await serveActionHomes({ homes: [{ key: 'home', serverUrl: 'https://transcript-files.test',
        accountId: 'alice', currentAccount: true }, { key: 'other', serverUrl: 'https://transcript-files-other.test', accountId: 'alice' }], route: () => undefined });
    disposeHome = homes.dispose;
    disconnectHome = await homes.restoreActiveConnection();
    const [{ WorkspaceProvider }, { AppPaneProvider }, { resolveCompactAppDestinations }, { StructuredReferencesRow }, { storage }, { useTranscriptFileLinks },
        { TranscriptTurnChangesCard }, { scmFileStatusFromChange }, { toTestIdSafeValue }] = production;
    const initial = storage.getState();
    const scope = initial.profileScope!;
    const targetServerId = homes.homes.other!.id;
    expect(targetServerId).not.toBe(scope.serverId);
    storage.setState({ isDataReady: true, settings: { ...initial.settings, scmChangedFilesLayout: 'list' } });
    const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
        externalSessions: false, inbox: false, workflows: false, friends: false,
    } });
    let navigation!: WorkspaceNavigationContextValue;
    let links!: ReturnType<typeof useTranscriptFileLinks>;
    function HookProbe() {
        links = useTranscriptFileLinks({ sessionId: 's1', serverId: targetServerId, workspacePath: '/repo', canOpenFiles: true });
        return null;
    }
    const source = createTestSessionTranscriptSource({ sessionId: 's1', serverId: targetServerId, workspacePath: '/repo', navigate: () => {
        throw new Error('File references must use the workspace Action, not source navigation');
    } });
    const screen = await renderWithSessionTranscriptSource(<AppPaneProvider><WorkspaceProvider enabled catalog={catalog}>
        {owner => { navigation = owner; return <><HookProbe /><StructuredReferencesRow sessionId="s1" serverId={targetServerId}
            references={[{ kind: 'file', path: 'src/a.ts' }]} fileOpenEnabled />
            <TranscriptTurnChangesCard sessionId="s1" serverId={targetServerId} turnId="turn-4" fileOpenEnabled
                files={[scmFileStatusFromChange({ path: 'src/turn.ts', changeKind: 'modified', added: 1, removed: 1 })]}
                firstHunkAnchors={{ 'src/turn.ts': { kind: 'diffLine', side: 'after', startLine: 40, newLine: 40, oldLine: null } }} />
        </>; }}
    </WorkspaceProvider></AppPaneProvider>, source);
    try {
        await vi.waitFor(async () => { await act(async () => {}); expect(navigation.active || navigation.ownsRoute).toBe(true); });
        await screen.pressByTestIdAsync('linked-workspace-file:src/a.ts');
        await vi.waitFor(async () => {
            await act(async () => {});
            const group = navigation.state.groups[navigation.state.focusedGroupId];
            expect(navigation.state.tabs[group.activeTabId].target).toMatchObject({ kind: 'session',
                params: { id: 's1', serverId: targetServerId, details: 'file', path: 'src/a.ts', fileView: 'view' } });
        });
        await act(async () => { expect(links.onMarkdownLinkPress('src/range.ts:5-8')).toBe(true); });
        await vi.waitFor(() => {
            const group = navigation.state.groups[navigation.state.focusedGroupId];
            expect(navigation.state.tabs[group.activeTabId].target).toMatchObject({ kind: 'session', params: {
                serverId: targetServerId, path: 'src/range.ts', source: 'file', anchor: 'range', startLine: '5', endLine: '8',
            } });
        });
        await act(async () => { links.openPath('.happier/uploads/tools/t1/recording.webm'); });
        await vi.waitFor(() => {
            const group = navigation.state.groups[navigation.state.focusedGroupId];
            expect(navigation.state.tabs[group.activeTabId].target).toMatchObject({ kind: 'session', params: {
                serverId: targetServerId, path: '.happier/uploads/tools/t1/recording.webm', fileView: 'view',
            } });
        });
        await screen.pressByTestIdAsync('turn-changes-card:turn-4-toggle');
        await screen.pressByTestIdAsync(`scm-change-row-${toTestIdSafeValue('src/turn.ts')}`);
        await vi.waitFor(() => {
            const group = navigation.state.groups[navigation.state.focusedGroupId];
            expect(navigation.state.tabs[group.activeTabId].target).toMatchObject({ kind: 'session', params: {
                serverId: targetServerId, path: 'src/turn.ts', fileView: 'changes', source: 'diff', anchor: 'diffLine', startLine: '40',
                comparison: 'turnCheckpoint', turnId: 'turn-4',
            } });
        });
        await act(async () => { links.onJumpToAnchor?.({ filePath: 'src/review.ts', source: 'diff',
            anchor: { kind: 'diffLine', side: 'after', startLine: 12, newLine: 12, oldLine: null } }); });
        await vi.waitFor(() => {
            const group = navigation.state.groups[navigation.state.focusedGroupId];
            expect(navigation.state.tabs[group.activeTabId].target).toMatchObject({ kind: 'session', params: {
                serverId: targetServerId, path: 'src/review.ts', fileView: 'changes', source: 'diff', anchor: 'diffLine', startLine: '12',
            } });
        });
    } finally { await screen.unmount(); storage.setState(initial, true); }
});

it('keeps public file references inert without a workspace owner', async () => {
    const [, , , { StructuredReferencesRow }] = production;
    const source = createTestSessionTranscriptSource({ sessionId: 'public', navigate: null });
    const screen = await renderWithSessionTranscriptSource(<StructuredReferencesRow sessionId="public"
        references={[{ kind: 'file', path: 'src/private.ts' }]} fileOpenEnabled={false} />, source);
    try {
        const chip = screen.findByTestId('linked-workspace-file:src/private.ts');
        expect(chip?.props.onPress).toBeUndefined();
        expect(chip?.props.accessibilityRole).toBe('text');
    } finally { await screen.unmount(); }
});
