import * as React from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { HappierMaterialRoleProvider } from '@happier-dev/plugin-ui/presentation';

const webScaffoldLayout = vi.hoisted(() => ({
    bottomInset: 0,
    lastOptions: undefined as { availablePanelMaxHeight?: number; keyboardLiftSuppressed?: boolean } | undefined,
}));

const modalState = vi.hoisted(() => ({
    insideModalBoundary: false,
    suppressed: false,
}));

vi.mock('./useComposerKeyboardLayout.web', () => ({
    useComposerKeyboardLayout: (options: { availablePanelMaxHeight?: number; keyboardLiftSuppressed?: boolean } = {}) => {
        webScaffoldLayout.lastOptions = options;
        return {
            availablePanelHeight: { value: 0 },
            bottomInset: { value: webScaffoldLayout.bottomInset },
            composerHeight: { value: 0 },
            isKeyboardLiftSuppressed: { value: false },
            keyboardHeightForInset: { value: webScaffoldLayout.bottomInset },
            keyboardHeightLive: { value: webScaffoldLayout.bottomInset },
            keyboardProgress: { value: webScaffoldLayout.bottomInset > 0 ? 1 : 0 },
            listBottomInset: { value: 0 },
            setComposerMeasuredHeight: vi.fn(),
        };
    },
}));

vi.mock('@/modal', () => ({
    useOptionalModal: () => ({
        isKeyboardLiftSuppressedByModal: modalState.suppressed,
        state: { modals: modalState.suppressed ? [{ id: 'modal', type: 'custom' }] : [] },
    }),
}));

vi.mock('@/modal/context/ModalBoundaryContext', () => ({
    useIsInsideModalBoundary: () => modalState.insideModalBoundary,
}));

vi.mock('react-native-reanimated', async () => {
    const React = await import('react');
    return {
        __esModule: true,
        default: {
            View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('AnimatedView', props, props.children),
        },
        useAnimatedStyle: (factory: () => unknown) => factory(),
    };
});

describe('ComposerKeyboardScaffold web', () => {
    it('inherits the containing content plane instead of covering the atmosphere with its own solid ground', async () => {
        const { ComposerKeyboardScaffold } = await import('./ComposerKeyboardScaffold.web');
        const screen = await renderScreen(<HappierMaterialRoleProvider role="content" resolveMaterialColor={() => 'transparent'}>
            <ComposerKeyboardScaffold mode="newSession" testID="scaffold" composerTestID="composer"
                composer={<React.Fragment>composer</React.Fragment>}><React.Fragment>content</React.Fragment></ComposerKeyboardScaffold>
        </HappierMaterialRoleProvider>);
        for (const id of ['scaffold', 'composer']) {
            const node = screen.tree.root.findAll(node => node.props.testID === id && typeof node.type === 'string' && ['AnimatedView', 'View'].includes(node.type))[0]!;
            expect(StyleSheet.flatten(node.props.style).backgroundColor).toBe('transparent');
        }
    });
    beforeEach(() => {
        modalState.insideModalBoundary = false;
        modalState.suppressed = false;
        webScaffoldLayout.bottomInset = 0;
        webScaffoldLayout.lastOptions = undefined;
    });

    it('pads the scaffold by the visual viewport keyboard inset', async () => {
        webScaffoldLayout.bottomInset = 320;
        const { ComposerKeyboardScaffold } = await import('./ComposerKeyboardScaffold.web');
        const screen = await renderScreen(
            <ComposerKeyboardScaffold
                mode="session"
                safeAreaBottom={20}
                testID="scaffold"
                contentTestID="content"
                composer={<React.Fragment>composer</React.Fragment>}
                composerTestID="composer"
            >
                <React.Fragment>content</React.Fragment>
            </ComposerKeyboardScaffold>,
        );

        const scaffold = screen.tree.root
            .findAllByType('AnimatedView' as never)
            .find((node) => node.props.testID === 'scaffold');
        if (!scaffold) {
            throw new Error('Expected scaffold root to render as an animated view');
        }
        expect(StyleSheet.flatten(scaffold.props.style).paddingBottom).toBe(300);
    });

    it('passes the measured scaffold height as the available panel cap', async () => {
        const { ComposerKeyboardScaffold } = await import('./ComposerKeyboardScaffold.web');
        const screen = await renderScreen(
            <ComposerKeyboardScaffold
                mode="newSession"
                testID="scaffold"
                composer={<React.Fragment>composer</React.Fragment>}
            >
                <React.Fragment>content</React.Fragment>
            </ComposerKeyboardScaffold>,
        );

        const scaffold = screen.tree.root
            .findAllByType('AnimatedView' as never)
            .find((node) => node.props.testID === 'scaffold');
        if (!scaffold) {
            throw new Error('Expected scaffold root to render as an animated view');
        }
        expect(typeof scaffold.props.onLayout).toBe('function');

        act(() => {
            scaffold.props.onLayout({ nativeEvent: { layout: { height: 420 } } });
        });

        expect(webScaffoldLayout.lastOptions?.availablePanelMaxHeight).toBe(420);
    });

    it('applies array style overrides without nesting them under the scaffold style array', async () => {
        const { ComposerKeyboardScaffold } = await import('./ComposerKeyboardScaffold.web');
        const screen = await renderScreen(
            <ComposerKeyboardScaffold
                mode="newSession"
                testID="scaffold"
                style={[
                    { justifyContent: 'center' },
                    { justifyContent: 'flex-end' },
                ]}
                composer={<React.Fragment>composer</React.Fragment>}
            >
                <React.Fragment>content</React.Fragment>
            </ComposerKeyboardScaffold>,
        );

        const scaffold = screen.tree.root
            .findAllByType('AnimatedView' as never)
            .find((node) => node.props.testID === 'scaffold');
        if (!scaffold) {
            throw new Error('Expected scaffold root to render as an animated view');
        }
        const style = scaffold.props.style as unknown[];

        expect(style.some(Array.isArray)).toBe(false);
        expect(StyleSheet.flatten(style as StyleProp<ViewStyle>)?.justifyContent).toBe('flex-end');
    });

    it('suppresses background keyboard lift while a foreground modal owns keyboard avoidance', async () => {
        modalState.suppressed = true;
        const { ComposerKeyboardScaffold } = await import('./ComposerKeyboardScaffold.web');

        await renderScreen(
            <ComposerKeyboardScaffold
                mode="session"
                composer={<React.Fragment>composer</React.Fragment>}
            >
                <React.Fragment>content</React.Fragment>
            </ComposerKeyboardScaffold>,
        );

        expect(webScaffoldLayout.lastOptions?.keyboardLiftSuppressed).toBe(true);
    });

    it('does not suppress keyboard lift for scaffolds rendered inside a modal boundary', async () => {
        modalState.insideModalBoundary = true;
        modalState.suppressed = true;
        const { ComposerKeyboardScaffold } = await import('./ComposerKeyboardScaffold.web');

        await renderScreen(
            <ComposerKeyboardScaffold
                mode="session"
                composer={<React.Fragment>composer</React.Fragment>}
            >
                <React.Fragment>content</React.Fragment>
            </ComposerKeyboardScaffold>,
        );

        expect(webScaffoldLayout.lastOptions?.keyboardLiftSuppressed).toBe(false);
    });

    it('publishes where the composer band rests in the window, not counting the keyboard lift', async () => {
        // The browser's layout measurement is the boundary; the shell registry stays real. The
        // test window is 600 tall: a 120 band lifted 300 by the keyboard is measured at y 140.
        webScaffoldLayout.bottomInset = 320;
        const { ComposerKeyboardScaffold } = await import('./ComposerKeyboardScaffold.web');
        const {
            SessionCockpitChromeRegistryProvider,
            useSessionCockpitComposerChromeHeight,
            useSessionCockpitComposerChromeTop,
        } = await import('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry');
        function Probe() {
            return <React.Fragment>{`top=${useSessionCockpitComposerChromeTop()} height=${useSessionCockpitComposerChromeHeight()}`}</React.Fragment>;
        }
        const screen = await renderScreen(
            <SessionCockpitChromeRegistryProvider>
                <ComposerKeyboardScaffold
                    mode="session"
                    safeAreaBottom={20}
                    composer={<React.Fragment>composer</React.Fragment>}
                    composerTestID="composer"
                >
                    <React.Fragment>content</React.Fragment>
                </ComposerKeyboardScaffold>
                <Probe />
            </SessionCockpitChromeRegistryProvider>,
            {
                createNodeMock: (element) => (element.props as { testID?: string }).testID === 'composer'
                    ? { measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 140, 800, 120) }
                    : null,
            },
        );

        await act(async () => {
            screen.findByTestId('composer')!.props.onLayout({ nativeEvent: { layout: { height: 120 } } });
        });
        expect(screen.getTextContent()).toContain('top=160 height=120');
    });

    it('withdraws the band of a composer that is not rendered (a hidden workspace screen)', async () => {
        // A display:none screen still holds a mounted composer; it measures as a 0×0 box at the
        // window origin. Published as-is, its "top" is the whole window and every shell overlay
        // placed above composers climbs onto the title strip (R13).
        webScaffoldLayout.bottomInset = 320;
        const { ComposerKeyboardScaffold } = await import('./ComposerKeyboardScaffold.web');
        const {
            SessionCockpitChromeRegistryProvider,
            useSessionCockpitComposerChromeHeight,
            useSessionCockpitComposerChromeTop,
        } = await import('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry');
        function Probe() {
            return <React.Fragment>{`top=${useSessionCockpitComposerChromeTop()} height=${useSessionCockpitComposerChromeHeight()}`}</React.Fragment>;
        }
        const screen = await renderScreen(
            <SessionCockpitChromeRegistryProvider>
                <ComposerKeyboardScaffold mode="session" safeAreaBottom={20} composer={<React.Fragment>visible</React.Fragment>} composerTestID="composer-visible">
                    <React.Fragment>content</React.Fragment>
                </ComposerKeyboardScaffold>
                <ComposerKeyboardScaffold mode="session" safeAreaBottom={20} composer={<React.Fragment>hidden</React.Fragment>} composerTestID="composer-hidden">
                    <React.Fragment>content</React.Fragment>
                </ComposerKeyboardScaffold>
                <Probe />
            </SessionCockpitChromeRegistryProvider>,
            {
                createNodeMock: (element) => {
                    const testID = (element.props as { testID?: string }).testID;
                    if (testID === 'composer-visible') return { measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 140, 800, 120) };
                    if (testID === 'composer-hidden') return { measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 0, 0, 0) };
                    return null;
                },
            },
        );

        await act(async () => {
            screen.findByTestId('composer-visible')!.props.onLayout({ nativeEvent: { layout: { height: 120 } } });
            screen.findByTestId('composer-hidden')!.props.onLayout({ nativeEvent: { layout: { height: 150 } } });
        });
        expect(screen.getTextContent()).toContain('top=160 height=120');
    });
});
