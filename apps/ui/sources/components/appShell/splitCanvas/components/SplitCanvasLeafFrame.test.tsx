import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import { StyleSheet } from 'react-native';
import Color from 'color';
import { createEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropRuntime';
import { splitCanvasEntityTargetId, useSplitCanvasDnD, type SplitCanvasEntityDrop } from '../hooks/useSplitCanvasDnD';
import type { SplitCanvasLeafHostRef } from '../model/splitCanvasTypes';

installPanelCommonModuleMocks();

describe('SplitCanvasLeafFrame', () => {
    it('keeps the mounted drop zones registered when only the focus action changes', async () => {
        const { SplitCanvasLeafFrame } = await import('./SplitCanvasLeafFrame');
        const runtime = createEntityDragDropRuntime();
        const scope = { serverId: 'home', accountId: 'owner' };
        runtime.registerSource({ id: 'source', scope, isCurrent: () => true,
            getItem: () => ({ kind: 'session', scope, address: { serverId: scope.serverId, sessionId: 'session' } }) });
        const writes: unknown[] = [];
        const entityDrop: SplitCanvasEntityDrop = { runtime, scope, id: 'canvas', acceptedKinds: ['session'], label: target => target.leafId,
            resolve: ({ target }) => ({ status: 'allowed', effect: { actionId: 'test.pane.open', input: target,
                preview: { verb: 'Open', target: target.leafId } } }),
            execute: async effect => { writes.push(effect.input); return { status: 'applied' }; } };
        const host = Object.assign(new EventTarget(), {
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
        });
        function MountedFrame({ onFocus }: { onFocus: () => void }) {
            const dnd = useSplitCanvasDnD({ entityDrop, isLeafCurrent: () => true,
                isSplitOffered: () => true, readSplitMeasurement: () => null });
            const onHostRefChange = React.useCallback((node: SplitCanvasLeafHostRef | null) => {
                dnd.registerLeafHost('leaf-a', node);
            }, [dnd.registerLeafHost]);
            return <SplitCanvasLeafFrame leafId="leaf-a" isFocused={false} isMaximized={false}
                showControls={false} showFocusRing={false} onFocus={onFocus} onHostRefChange={onHostRefChange}
                onClose={() => {}} onToggleMaximize={() => {}}><Child /></SplitCanvasLeafFrame>;
        }
        const firstFocus = vi.fn();
        const currentFocus = vi.fn();
        const screen = await renderScreen(<MountedFrame onFocus={firstFocus} />, {
            createNodeMock: element => element.props.testID === 'split-canvas-leaf-frame-leaf-a' ? host : null,
        });
        expect(runtime.getDestinations('source')).toHaveLength(5);
        const publications = vi.fn();
        const unsubscribe = runtime.subscribe(publications);
        await screen.update(<MountedFrame onFocus={currentFocus} />);
        host.dispatchEvent(new Event('pointerdown'));
        expect(currentFocus).toHaveBeenCalledTimes(1);
        expect(firstFocus).not.toHaveBeenCalled();
        expect(publications).not.toHaveBeenCalled();
        const center = runtime.getDestinations('source').find(destination => destination.targetId === splitCanvasEntityTargetId('canvas', 'leaf-a', 'center'));
        expect(center).toBeDefined();
        await runtime.perform('source', center!.targetId, center!.destination, 'chooser');
        expect(writes).toEqual([{ leafId: 'leaf-a', placement: 'center' }]);
        // A foreign producer cannot dispatch through these same mounted zones.
        const foreignScope = { ...scope, accountId: 'other-account' };
        runtime.registerSource({ id: 'foreign', scope: foreignScope, isCurrent: () => true,
            getItem: () => ({ kind: 'session', scope: foreignScope, address: { serverId: scope.serverId, sessionId: 'foreign' } }) });
        await runtime.perform('foreign', center!.targetId, center!.destination, 'chooser');
        expect(writes).toHaveLength(1);
        unsubscribe();
        await screen.unmount();
    });

    it('inherits the content plane instead of painting another opaque frame', async () => {
        const { SplitCanvasLeafFrame } = await import('./SplitCanvasLeafFrame');
        const { AppShellMaterialFrame } = await import('@/components/navigation/shell/AppShellMaterialFrame');
        const { GlassMaterialSettingsProvider } = await import('@/components/ui/glass/useGlassMaterialSettings');
        const { GlassRuntimeEnvironmentProvider } = await import('@/components/ui/glass/glassRuntimeEnvironment');
        const { glassPresetMaterials } = await import('@/components/ui/glass/glassMaterial');
        const screen = await renderScreen(
            <GlassRuntimeEnvironmentProvider value={{ desktopWindow: true, nativeWindowMaterialLive: true }}>
            <GlassMaterialSettingsProvider value={{ glassBlurEnabled: true, glassSurfaceMaterials: glassPresetMaterials('everywhere') }}>
            <AppShellMaterialFrame showChrome={false} dragEnabled={false} leftOffsetPx={0} sidebarWidth={320}
                titleStrip={null} rail={null} column={null} peek={null}>
                <SplitCanvasLeafFrame leafId="glass" isFocused={false} isMaximized={false}
                    showControls showFocusRing={false} onFocus={() => {}} onClose={() => {}} onToggleMaximize={() => {}}>
                    <Child />
                </SplitCanvasLeafFrame>
            </AppShellMaterialFrame>
            </GlassMaterialSettingsProvider>
            </GlassRuntimeEnvironmentProvider>,
        );
        const frame = StyleSheet.flatten(screen.findByTestId('split-canvas-leaf-interaction-surface-glass')!.props.style);
        expect(Color(frame.backgroundColor).alpha()).toBe(0);
        expect(frame.opacity).toBeUndefined();
    });

    it('exposes descendant-interaction capture on the shared leaf surface', async () => {
        const onFocus = vi.fn();
        const onClose = vi.fn();
        const onToggleMaximize = vi.fn();

        const { SplitCanvasLeafFrame } = await import('./SplitCanvasLeafFrame');

        const screen = await renderScreen(
            <SplitCanvasLeafFrame
                leafId="leaf-a"
                isFocused={false}
                isMaximized={false}
                showControls
                showFocusRing={false}
                onFocus={onFocus}
                onClose={onClose}
                onToggleMaximize={onToggleMaximize}
            >
                <Child />
            </SplitCanvasLeafFrame>,
        );

        invokeTestInstanceHandler(
            screen.findByTestId('split-canvas-leaf-interaction-surface-leaf-a'),
            'onStartShouldSetResponderCapture',
            {},
            'split-canvas-leaf-interaction-surface-leaf-a',
        );

        expect(onFocus).toHaveBeenCalledTimes(1);
    });
});

function Child() {
    return React.createElement('LeafChild');
}
