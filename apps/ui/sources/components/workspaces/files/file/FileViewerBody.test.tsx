import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key) => key });
});
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock().module;
});
vi.mock('expo-image', () => ({ Image: 'ExpoImage' }));

import { resolveFileViewerKind } from '@/scm/utils/filePresentation';
import { FileViewerBody } from './FileViewerBody';

describe('FileViewerBody', () => {
  it('opens a workspace image in the Media stage with the page preview identity, without a session', async () => {
    const source = {
      enabled: true,
      source: { kind: 'uri' as const, uri: 'blob:preview' },
      cacheScopeId: 'scope:workspace',
      cacheKey: '["design/layout.png",412,"sig"]',
    };
    const screen = await renderScreen(
      <FileViewerBody
        viewer={resolveFileViewerKind({ path: 'design/layout.png' })}
        title="layout.png"
        source={source}
        isActive
        findSurfaceId="file:test"
        testID="body"
      />,
    );
    await screen.pressByTestIdAsync('body-open');
    const { Modal } = await import('@/modal');
    expect(Modal.show).toHaveBeenCalledTimes(1);
    const [config] = vi.mocked(Modal.show).mock.calls[0] ?? [];
    expect(config?.chrome).toMatchObject({
      kind: 'stage',
      title: 'layout.png',
    });
    expect(config?.props?.items).toHaveLength(1);
    expect(config?.props?.items[0]).toMatchObject({
      kind: 'image',
      title: 'layout.png',
      source,
    });
    expect(config?.props?.items[0].originRef).toBe(config?.focusReturnRef);
  });

  it('says what an opaque file is and offers Download and Open as text', async () => {
    const onDownload = vi.fn();
    const onOpenAsText = vi.fn();
    const screen = await renderScreen(
      <FileViewerBody
        viewer={resolveFileViewerKind({
          path: 'target/release/happier',
          isBinaryContent: true,
        })}
        title="happier"
        source={{ enabled: false, source: { kind: 'uri', uri: '' } }}
        sizeBytes={48_600_000}
        isActive
        findSurfaceId="file:test"
        onDownload={onDownload}
        onOpenAsText={onOpenAsText}
        testID="binary"
      />,
    );
    expect(screen.getTextContent()).toContain('happier');
    expect(screen.getTextContent()).toContain('48.6 MB');
    await screen.pressByTestIdAsync('binary:download');
    expect(onDownload).toHaveBeenCalledTimes(1);
    await screen.pressByTestIdAsync('binary-identity-learn-more');
    expect(onOpenAsText).toHaveBeenCalledTimes(1);
  });
});
