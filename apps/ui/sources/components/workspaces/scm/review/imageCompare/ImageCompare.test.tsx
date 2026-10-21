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

    it('says an interrupted read failed and retries that side, while an unreadable revision offers no retry', async () => {
        const onRetry = vi.fn();
        const interrupted = 'The direct machine connection was interrupted. Retry the transfer.';
        const preview = { enabled: false, source: { kind: 'uri' as const, uri: '' } };
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
            <ImageCompare filePath="assets/logo.svg" kind="svg" alphaCapable
                before={{ kind: 'unreadable', cause: 'unverified', reason: 'The revision bytes do not match their content hash.' }}
                after={{ kind: 'loadFailed', error: interrupted }}
                beforePreviewInput={preview} afterPreviewInput={preview} onRetry={onRetry} />
        </InjectedAuthProvider>);
        try {
            const text = screen.getTextContent();
            expect(text).toContain("Couldn't load logo.svg");
            expect(text).toContain('This image could not be read');
            expect(screen.findByTestId('image-compare-before-retry')).toBeNull();
            await act(async () => screen.pressByTestId('image-compare-after-retry'));
            expect(onRetry).toHaveBeenCalledWith('after');
            expect(onRetry).toHaveBeenCalledOnce();
        } finally { await screen.unmount(); }
    });

    it.each([
        { name: 'over budget', side: { kind: 'noPreview', reason: 'too_large', sizeBytes: 40_000_000 }, says: ['Too large to preview', '40'] },
        { name: 'unsupported', side: { kind: 'noPreview', reason: 'unsupported' }, says: ["Can't preview this format"] },
        { name: 'missing', side: { kind: 'unreadable', cause: 'missing', reason: 'not found' }, says: ['Missing from this version'] },
    ] as const)('says why a side is $name and offers no retry', async ({ side, says }) => {
        const onRetry = vi.fn();
        const preview = { enabled: false, source: { kind: 'uri' as const, uri: '' } };
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
            <ImageCompare filePath="assets/hero.png" kind="image" alphaCapable={false}
                before={side} after={{ kind: 'loadFailed', error: 'interrupted' }}
                beforePreviewInput={preview} afterPreviewInput={preview} onRetry={onRetry} />
        </InjectedAuthProvider>);
        try {
            const text = screen.getTextContent();
            for (const phrase of says) expect(text).toContain(phrase);
            expect(text).not.toContain('No preview');
            expect(screen.findByTestId('image-compare-before-retry')).toBeNull();
            expect(screen.findByTestId('image-compare-after-retry')).not.toBeNull();
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
