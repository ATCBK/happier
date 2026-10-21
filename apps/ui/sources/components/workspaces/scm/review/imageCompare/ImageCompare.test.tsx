import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { ImageCompare } from './ImageCompare';
import { ImageWell } from '@/components/ui/media/ImageWell';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';

const decoder = vi.hoisted(() => ({ renders: 0 }));
// Native image drawing/loading is the boundary; retain real ImageWell and preview logic.
vi.mock('expo-image', () => ({ Image: (props: object) => {
    if (++decoder.renders > 25) throw new Error('Image comparison did not settle after image load');
    return React.createElement('DecodedImage', props);
} }));

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

describe('ImageCompare dimension reporting', () => {
    beforeEach(() => { decoder.renders = 0; });
    it.each(['changed', 'added'] as const)('settles after layout and intrinsic load for an %s image', async kind => {
        const preview = { enabled: true, source: { kind: 'uri' as const, uri: 'blob:image' } };
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
                <ImageCompare filePath="logo.png" kind="image" alphaCapable={false}
                    before={kind === 'added' ? { kind: 'added' } : { kind: 'present', uri: 'blob:before', sizeBytes: 10 }}
                    after={{ kind: 'present', uri: 'blob:after', sizeBytes: 20 }}
                    beforePreviewInput={preview} afterPreviewInput={preview} />
        </InjectedAuthProvider>);
        try {
            await act(async () => {
                screen.findByTestId('image-compare-after')!.props.onLayout({ nativeEvent: { layout: { width: 500, height: 300 } } });
                screen.findByTestId('image-compare-after-picture')!.props.onLoad({ source: { width: 100, height: 60 } });
            });
            expect(decoder.renders).toBeLessThan(10);
            const settled = decoder.renders;
            await act(async () => {});
            expect(decoder.renders).toBe(settled);
        } finally { await screen.unmount(); }
    });

    it('lifts a loaded well into the stage when a two-touch pinch starts', async () => {
        const onOpenStage = vi.fn();
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
            <ImageWell kind="image" title="photo.png" alphaCapable={false} layout="inline"
                source={{ enabled: true, source: { kind: 'uri', uri: 'blob:photo' } }} onOpenStage={onOpenStage} />
        </InjectedAuthProvider>);
        try {
            const detector = screen.findByType('GestureDetector');
            await act(async () => detector.props.gesture.__handlers.onStart({ numberOfPointers: 2 }));
            expect(onOpenStage).toHaveBeenCalledOnce();
        } finally { await screen.unmount(); }
    });
});
