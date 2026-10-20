import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { AppPaneScopeHost } from '@/components/appShell/panes/AppPaneScopeHost';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { pressTestInstanceAsync, renderWithSessionTranscriptSource, createTestSessionTranscriptSource } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

const routerPushSpy = vi.hoisted(() => vi.fn());
function renderScreen(element: React.ReactElement) {
    return renderWithSessionTranscriptSource(element, createTestSessionTranscriptSource({ sessionId: 's1', navigate: routerPushSpy }));
}
vi.mock('@/utils/platform/responsive', () => ({
  useDeviceType: () => 'tablet',
}));

vi.hoisted(async () => {
    const { installProjectFileLinkPickerCommonModuleMocks } = await import('@/components/sessions/linkedFiles/projectPicker/projectFileLinkPickerTestHelpers');

    installProjectFileLinkPickerCommonModuleMocks({
        reactNative: async () => {
            const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
            return createReactNativeWebMock({
                useWindowDimensions: () => ({ width: 1400, height: 900 }),
            });
        },
        router: async () => {
            const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
            const expoRouterMock = createExpoRouterMock({
                pathname: () => '/session/s1',
                router: { push: routerPushSpy },
            });
            return expoRouterMock.module;
        },
        storage: async () => {
            const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
            return createStorageModuleStub({
                useLocalSetting: (key: string) => {
                    if (key === 'uiMultiPanePanelsEnabled') return true;
                    if (key === 'detailsPaneTabsBehavior') return 'preview';
                    return undefined;
                },
            });
        },
    });

    return null;
});

afterEach(() => {
    routerPushSpy.mockReset();
});

describe('StructuredReferencesRow file references', () => {
    it('opens the exact Home pane when two Homes use the same session id', async () => {
        const { StructuredReferencesRow } = await import('./StructuredReferencesRow');
        const firstScopeId = createSessionPaneScopeId('same-session', 'server-a');
        const secondScopeId = createSessionPaneScopeId('same-session', 'server-b');
        let firstState: any = null;
        let secondState: any = null;
        const Probe = () => {
            firstState = useAppPaneScope(firstScopeId).scopeState;
            secondState = useAppPaneScope(secondScopeId).scopeState;
            return null;
        };

        const screen = await renderScreen(
            <AppPaneProvider>
                <StructuredReferencesRow
                    sessionId="same-session"
                    serverId="server-a"
                    references={[{ kind: 'file', path: 'src/a.ts' }]}
                    fileOpenEnabled
                />
                <StructuredReferencesRow
                    sessionId="same-session"
                    serverId="server-b"
                    references={[{ kind: 'file', path: 'src/b.ts' }]}
                    fileOpenEnabled
                />
                <Probe />
            </AppPaneProvider>,
        );

        await pressTestInstanceAsync(screen.findByTestId('linked-workspace-file:src/a.ts')!, 'linked-workspace-file:src/a.ts');

        expect(firstState?.details?.tabs?.[0]?.key).toBe('file:src/a.ts');
        expect(secondState?.details?.isOpen ?? false).toBe(false);
    });

    it('opens details tab when multi-pane is available', async () => {
        const { StructuredReferencesRow } = await import('./StructuredReferencesRow');

        let observedState: any = null;
        const Probe = () => {
            observedState = useAppPaneScope('session:s1').scopeState;
            return null;
        };

        const screen = await renderScreen(
            <AppPaneProvider>
                <StructuredReferencesRow sessionId="s1" references={[{ kind: 'file', path: 'src/api.ts' }]} fileOpenEnabled />
                <Probe />
            </AppPaneProvider>,
        );

        const fileChip = screen.findByTestId('linked-workspace-file:src/api.ts');
        expect(fileChip).toBeTruthy();
        await pressTestInstanceAsync(fileChip!, 'linked-workspace-file:src/api.ts');

        expect(routerPushSpy).not.toHaveBeenCalled();
        expect(observedState?.details?.isOpen).toBe(true);
        expect(observedState?.details?.tabs?.[0]?.key).toBe('file:src/api.ts');
        expect(observedState?.details?.activeTabKey).toBe('file:src/api.ts');
    });

    it('uses the measured pane width instead of the global window width when deciding how to open a file', async () => {
        const { StructuredReferencesRow } = await import('./StructuredReferencesRow');

        let observedState: any = null;
        const Probe = () => {
            observedState = useAppPaneScope('session:s1').scopeState;
            return null;
        };

        const screen = await renderScreen(
            <AppPaneProvider>
                <AppPaneScopeHost
                    scopeId="session:s1"
                    main={
                        <>
                            <StructuredReferencesRow sessionId="s1" references={[{ kind: 'file', path: 'src/api.ts' }]} fileOpenEnabled />
                            <Probe />
                        </>
                    }
                />
            </AppPaneProvider>,
        );

        const hostRoot = screen.findByType('View' as any);
        expect(typeof hostRoot.props.onLayout).toBe('function');

        await act(async () => {
            hostRoot.props.onLayout({ nativeEvent: { layout: { width: 800, height: 900 } } });
        });

        const fileChip = screen.findByTestId('linked-workspace-file:src/api.ts');
        expect(fileChip).toBeTruthy();
        await pressTestInstanceAsync(fileChip!, 'linked-workspace-file:src/api.ts');

        expect(routerPushSpy).toHaveBeenCalledWith('/session/s1/file?path=src%2Fapi.ts');
        expect(observedState?.details?.isOpen ?? false).toBe(false);
    });

    it('keeps linked file chips shrinkable inside constrained panes', async () => {
        const { StructuredReferencesRow } = await import('./StructuredReferencesRow');

        const screen = await renderScreen(
            <AppPaneProvider>
                <StructuredReferencesRow sessionId="s1" references={[{ kind: 'file', path: 'deep/nested/AGENTS.md' }]} fileOpenEnabled />
            </AppPaneProvider>,
        );

        const fileChip = screen.findByTestId('linked-workspace-file:deep/nested/AGENTS.md');
        expect(fileChip).toBeTruthy();
        const row = fileChip?.parent;
        const rowStyle = typeof row?.props?.style === 'function'
            ? row.parent?.props?.style
            : row?.props?.style;
        expect(rowStyle).toEqual(
            expect.objectContaining({
                maxWidth: '100%',
                minWidth: 0,
            }),
        );
        expect(fileChip?.props?.style({ pressed: false })).toEqual([
            expect.objectContaining({
                maxWidth: '100%',
                minWidth: 0,
                flexShrink: 1,
            }),
            null,
        ]);
    });

    it('renders public linked files as inert metadata', async () => {
        const { StructuredReferencesRow } = await import('./StructuredReferencesRow');
        const screen = await renderScreen(
            <AppPaneProvider>
                <StructuredReferencesRow
                    sessionId="public"
                    references={[{ kind: 'file', path: 'src/private.ts' }]}
                    fileOpenEnabled={false}
                />
            </AppPaneProvider>,
        );

        const fileChip = screen.findByTestId('linked-workspace-file:src/private.ts');
        expect(fileChip?.type).toBe('View');
        expect(fileChip?.props.accessibilityRole).toBe('text');
        expect(fileChip?.props.onPress).toBeUndefined();
    });
});
