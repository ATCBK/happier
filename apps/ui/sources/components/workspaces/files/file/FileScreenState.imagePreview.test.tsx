import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { createThemeFixture } from '@/dev/testkit/fixtures/themeFixtures';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
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

import { FileBinaryState } from './FileScreenState';

describe('workspace file image preview', () => {
    it('opens the shared viewer with the selected workspace file, without a session', async () => {
        const workspaceScope = { serverId: 'server', machineId: 'machine', rootPath: '/other-workspace' };
        const screen = await renderScreen(<FileBinaryState
            theme={createThemeFixture()}
            filePath="design/layout.png"
            imagePreviewUri="data:image/png;base64,AQ=="
            workspaceScope={workspaceScope}
        />);
        await screen.pressByTestIdAsync('file-image-preview');
        const { Modal } = await import('@/modal');
        const { AttachmentImagePreviewModal } = await import('@/components/sessions/attachments/preview/AttachmentImagePreviewModal');
        expect(Modal.show).toHaveBeenCalledWith({
            component: AttachmentImagePreviewModal,
            props: { images: [{ kind: 'session-image', sessionId: '', workspaceScope, filePath: 'design/layout.png', title: 'layout.png' }] },
        });
    });
});
