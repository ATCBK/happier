import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { ImageWell } from './ImageWell';

// Native image drawing is the boundary; the preview owner and its size guard stay real.
vi.mock('expo-image', () => ({ Image: (props: object) => React.createElement('DecodedImage', props) }));
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

describe('ImageWell without a picture', () => {
    it('says an over-budget image is too large and offers no retry', async () => {
        const bytes = new Uint8Array(4096);
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
            <ImageWell testID="well" kind="image" title="hero.png" alphaCapable={false} layout="inline"
                source={{ enabled: true, source: { kind: 'bytes', bytes, name: 'hero.png' }, mimeType: 'image/png', sizeBytes: 4096, maxBytes: 1024 }} />
        </InjectedAuthProvider>);
        try {
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('Too large to preview'));
            const text = screen.getTextContent();
            expect(text).not.toContain("Couldn't load");
            expect(text).not.toContain('Retry');
        } finally { await screen.unmount(); }
    });
});
