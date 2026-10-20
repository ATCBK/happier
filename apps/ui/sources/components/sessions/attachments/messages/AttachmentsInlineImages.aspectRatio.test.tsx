import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';
import { installReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { installUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import { installSessionAttachmentCommonModuleMocks } from '../sessionAttachmentTestHelpers';
import { createSessionFileNativeTransferBoundary } from '@/components/sessions/files/sessionFileNativeTransferTestkit';
import { createSessionFilesViewFixture, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';

installSessionAttachmentCommonModuleMocks({
    reactNative: installReactNativeWebMock({ Platform: { OS: 'ios', select: (values: { ios?: unknown; default?: unknown }) => values.ios ?? values.default } }),
    unistyles: installUnistylesMock({
        theme: { colors: { textSecondary: '#bbb', divider: '#222', surfaceHighest: '#111' } },
    }),
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('expo-file-system', async () => (await import('@/dev/testkit/mocks/expoFileSystem')).createExpoFileSystemFileMock().module);
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
beforeAll(prepareSessionFilesViewTestkit);
beforeEach(async () => {
    const transfer = createSessionFileNativeTransferBoundary();
    fixture = await createSessionFilesViewFixture({ sessionId: 's1', rootPath: '/repo', machineCarrierOrigin: transfer.origin,
        rpc: transfer.rpc, request: transfer.request });
    fixture.storage.getState().applySettingsLocal({ filesImagePreviewCacheMaxEntries: 0, filesImagePreviewMaxBytes: 1_000_000 });
});
afterEach(async () => { await fixture.dispose(); });

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    if (style && typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

describe('AttachmentsInlineImages aspect ratios', () => {
    it('preserves transcript attachment image aspect ratios after loaded previews report dimensions', async () => {
        const { AttachmentsInlineImages } = await import('./AttachmentsInlineImages');

        const attachment = {
            name: 'wide.png',
            path: '.happier/uploads/messages/message-1/wide.png',
            mimeType: 'image/png',
            sizeBytes: 10,
            sha256: 'hash',
        };

        const screen = await renderScreen(
            <AttachmentsInlineImages
                sessionId="s1"
                attachments={[attachment]}
                onOpenPath={() => {}}
                fileOpenEnabled
                mediaPreviewEnabled
            />,
        );

        const tileTestID = `message-attachments-inline-image:${attachment.path}`;
        const previewTestID = `message-attachments-inline-image-preview:${attachment.path}`;

        await vi.waitFor(() => expect(screen.findByTestId(previewTestID)).not.toBeNull());

        expect(flattenStyle(screen.findByTestId(tileTestID)?.props.style)).toMatchObject({
            width: 84,
            height: 84,
        });

        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId(previewTestID), 'onLoad', {
                cacheType: 'none',
                source: {
                    url: 'blob:preview',
                    width: 1600,
                    height: 900,
                    mediaType: 'image/png',
                },
            });
        });

        expect(flattenStyle(screen.findByTestId(tileTestID)?.props.style)).toMatchObject({
            width: 220,
            height: 124,
        });
        expect(screen.findByTestId(previewTestID)?.props.contentFit).toBe('contain');
    });
});
