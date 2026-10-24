import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { PluginUiReadStoredImageResultV1, StoredImageRefV1 } from '@happier-dev/plugin-sdk/ui';
import { mountThroughReactNativeWebAsync } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import { StoredImage } from './StoredImage.js';
import { PluginUiPresentationHostProviderInternal } from '../presentationHost/context.js';

describe('authorized StoredImage reference presentation', () => {
  it('expands the admitted URI through the mounted stage port and respects the author opt-out', async () => {
    const context = createSurfaceContext();
    const image: StoredImageRefV1 = { mediaId: 'media-1', mediaKind: 'image', width: 100, height: 60, sizeBytes: 24,
      file: { sessionId: 'session-1', storage: 'daemon', path: '.happier/uploads/artifacts/session-1/image.png',
        sha256: 'a'.repeat(64), mimeType: 'image/png' } };
    // Admission and byte acquisition are the host API boundary; the component and RNW press path are real.
    const hostApi = createHostApiStub(context, {
      readStoredImage: async () => ({ bytesBase64: 'cG5n', mimeType: 'image/png', width: 100, height: 60 }),
    });
    const open = vi.fn();
    const onPress = vi.fn();
    const render = (stage: boolean, expandable?: boolean) => <PluginUiProvider hostApi={hostApi} context={context}>
      <PluginUiPresentationHostProviderInternal host={{ renderMarkdown: () => null, renderCodeBlock: () => null,
        renderPopover: () => null, renderIcon: () => null,
        ...(stage ? { mediaStage: { open } } : {}),
        storedImageHost: { renderImage: ({ uri }) => <img src={uri} alt="Admitted image" /> } }}>
        <StoredImage image={image} accessibilityLabel="Capture" expandable={expandable} onPress={onPress} />
      </PluginUiPresentationHostProviderInternal>
    </PluginUiProvider>;
    const mount = await mountThroughReactNativeWebAsync(render(true));
    try {
      const press = () => act(() => { mount.container.querySelector<HTMLElement>('[aria-label="Capture"]')?.click(); });
      press();
      expect(open).toHaveBeenCalledWith([{ kind: 'image', uri: 'data:image/png;base64,cG5n', title: 'Capture', mimeType: 'image/png' }], 0);
      expect(onPress).not.toHaveBeenCalled();
      await mount.render(render(true, false));
      press();
      expect(onPress).toHaveBeenCalledTimes(1);
      await mount.render(render(false));
      press();
      expect(onPress).toHaveBeenCalledTimes(2);
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      mount.unmount();
    }
  });

  it('renders admitted image data and cancels the reference read when the viewer unmounts', async () => {
    const context = createSurfaceContext();
    let signal: AbortSignal | undefined;
    let complete: ((image: PluginUiReadStoredImageResultV1) => void) | undefined;
    const image: StoredImageRefV1 = { mediaId: 'media-1', mediaKind: 'image', width: 100, height: 60, sizeBytes: 24,
      file: { sessionId: 'session-1', storage: 'daemon', path: '.happier/uploads/artifacts/session-1/image.png',
        sha256: 'a'.repeat(64), mimeType: 'image/png' } };
    const references: StoredImageRefV1[] = [];
    const hostApi = createHostApiStub(context, {
      // The host API/decoder are external boundaries of this author component.
      readStoredImage: (ref, options) => { references.push(ref); signal = options?.signal; return new Promise((resolve) => { complete = resolve; }); },
    });
    const render = (reference: StoredImageRefV1) => <PluginUiProvider hostApi={hostApi} context={context}>
      <PluginUiPresentationHostProviderInternal host={{ renderMarkdown: () => null, renderCodeBlock: () => null,
        renderPopover: () => null, renderIcon: () => null,
        storedImageHost: { renderImage: ({ uri }) => <img src={uri} alt="Admitted image" /> } }}>
        <StoredImage image={reference} accessibilityLabel="Capture" />
      </PluginUiPresentationHostProviderInternal>
    </PluginUiProvider>;
    const mount = await mountThroughReactNativeWebAsync(render(image));
    expect(mount.container.querySelector('img')).toBeNull();
    expect(references).toEqual([image]);
    await act(async () => { complete?.({ bytesBase64: 'cG5n', mimeType: 'image/png', width: 100, height: 60 }); });
    expect(mount.container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,cG5n');
    expect(mount.container.querySelector('[aria-label="Capture"]')).not.toBeNull();
    await mount.render(render({ ...image, file: { ...image.file } }));
    expect(references).toEqual([image]);
    const oldSignal = signal;
    const changedImage = { ...image, file: { ...image.file, sha256: 'b'.repeat(64) } };
    await mount.render(render(changedImage));
    expect(oldSignal?.aborted).toBe(true);
    expect(references).toEqual([image, changedImage]);
    expect(mount.container.querySelector('img')).toBeNull();
    mount.unmount();
    expect(signal?.aborted).toBe(true);
  });
  it('lays the transparency checkerboard behind alpha-capable pictures and leaves a JPEG on its plain backdrop', async () => {
    const context = createSurfaceContext();
    const referenceFor = (mimeType: string, extension: string): StoredImageRefV1 => ({ mediaId: `media-${extension}`, mediaKind: 'image',
      width: 100, height: 60, sizeBytes: 24, file: { sessionId: 'session-1', storage: 'daemon',
        path: `.happier/uploads/artifacts/session-1/image.${extension}`, sha256: 'a'.repeat(64), mimeType } });
    // Byte acquisition is the host API boundary; the component, backing decision and RNW paint are real.
    const hostApi = createHostApiStub(context, {
      readStoredImage: async (ref) => ({ bytesBase64: 'cG5n', mimeType: ref.file.mimeType, width: 100, height: 60 }),
    });
    const render = (reference: StoredImageRefV1) => <PluginUiProvider hostApi={hostApi} context={context}>
      <PluginUiPresentationHostProviderInternal host={{ renderMarkdown: () => null, renderCodeBlock: () => null,
        renderPopover: () => null, renderIcon: () => null,
        storedImageHost: { renderImage: ({ uri }) => <img src={uri} alt="Admitted image" /> } }}>
        <StoredImage image={reference} accessibilityLabel="Logo" testID="logo" expandable={false} />
      </PluginUiPresentationHostProviderInternal>
    </PluginUiProvider>;
    const backing = (mount: Awaited<ReturnType<typeof mountThroughReactNativeWebAsync>>) =>
      mount.container.querySelector('[data-testid="logo-backing"]');
    const mount = await mountThroughReactNativeWebAsync(render(referenceFor('image/png', 'png')));
    try {
      expect(mount.container.querySelector('img')).not.toBeNull();
      expect(backing(mount)).not.toBeNull();
      for (const [mimeType, extension] of [['image/webp', 'webp'], ['image/gif', 'gif'], ['image/svg+xml', 'svg']] as const) {
        await mount.render(render(referenceFor(mimeType, extension)));
        expect(backing(mount), mimeType).not.toBeNull();
      }
      await mount.render(render(referenceFor('image/jpeg', 'jpg')));
      expect(mount.container.querySelector('img')).not.toBeNull();
      expect(backing(mount)).toBeNull();
    } finally {
      mount.unmount();
    }
  });
});
