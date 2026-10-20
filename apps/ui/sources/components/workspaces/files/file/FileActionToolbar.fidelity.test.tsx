import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { useUnistyles } from 'react-native-unistyles';
import { renderScreen } from '@/dev/testkit';
import { flushHookEffects } from '@/dev/testkit';
import { OverlayPortalHost, OverlayPortalProvider } from '@/components/ui/popover/OverlayPortal';

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

// Transform the shared real toolbar graph before a case opens an act() scope.
await import('./FileActionToolbar');

describe('file Details controls', () => {
    it('identifies the only available change area and starts editing from the overflow', async () => {
        const { FileActionToolbar } = await import('./FileActionToolbar');
        const edit = vi.fn();
        const display = vi.fn();
        function Harness() {
            const { theme } = useUnistyles();
            return <FileActionToolbar
                theme={theme} fileName="file.ts" displayMode="diff" onDisplayMode={display}
                diffMode="pending" onDiffMode={() => {}} hasPendingDelta hasIncludedDelta={false}
                scmWriteEnabled={false} includeExcludeEnabled={false} virtualSelectionEnabled={false}
                isSelectedForCommit={false} lineSelectionEnabled={false} selectedLineCount={0}
                isApplyingStage={false} inFlightScmOperation={null} onStageFile={() => {}}
                onUnstageFile={() => {}} onApplySelectedLines={() => {}} onClearSelection={() => {}}
                fileEditorEnabled onStartEditingFile={edit}
            />;
        }
        const screen = await renderScreen(<OverlayPortalProvider><Harness /><OverlayPortalHost /></OverlayPortalProvider>, {
            // Native view measurement is an external boundary; keep the real menu and placement path.
            createNodeMock: () => ({ measureInWindow: (cb: (x: number, y: number, width: number, height: number) => void) => cb(0, 0, 600, 40) }),
        });
        expect(screen.findByTestId('file-details-diff-area-menu.trigger')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('file-details-header.menu.trigger');
        // Dropdown opening deliberately yields a host task; flush that real timer boundary.
        await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
        await flushHookEffects({ cycles: 3, turns: 4 });
        await screen.pressByTestIdAsync('file-details-edit');
        await act(async () => { await vi.waitFor(() => expect(display).toHaveBeenCalledWith('file')); });
        expect(edit).toHaveBeenCalledOnce();
    });
    it('keeps only the facts and actions when the host already names the file', async () => {
        const { FileActionToolbar } = await import('./FileActionToolbar');
        function Harness(props: Readonly<{ hostNamesFile: boolean }>) {
            const { theme } = useUnistyles();
            return <FileActionToolbar
                theme={theme} fileName="SettingsModal.tsx" filePathDir="apps/ui/settings" hostNamesFile={props.hostNamesFile}
                summaryFacts={['14 lines']} displayMode="file" onDisplayMode={() => {}}
                diffMode="pending" onDiffMode={() => {}} hasPendingDelta={false} hasIncludedDelta={false}
                scmWriteEnabled={false} includeExcludeEnabled={false} virtualSelectionEnabled={false}
                isSelectedForCommit={false} lineSelectionEnabled={false} selectedLineCount={0}
                isApplyingStage={false} inFlightScmOperation={null} onStageFile={() => {}}
                onUnstageFile={() => {}} onApplySelectedLines={() => {}} onClearSelection={() => {}}
            />;
        }
        const named = await renderScreen(<OverlayPortalProvider><Harness hostNamesFile={false} /><OverlayPortalHost /></OverlayPortalProvider>);
        expect(named.findHostByTestId('file-details-header.title')).toBeTruthy();
        // The Code page's breadcrumb ends on the file: the reader's band doesn't name it, or its folder, a second time.
        const hosted = await renderScreen(<OverlayPortalProvider><Harness hostNamesFile /><OverlayPortalHost /></OverlayPortalProvider>);
        expect(hosted.findHostByTestId('file-details-header.title')).toBeNull();
        expect(hosted.findHostByTestId('file-details-dir')).toBeNull();
        expect(hosted.findHostByTestId('file-details-header.subtitle')).toBeTruthy();
    });
});
