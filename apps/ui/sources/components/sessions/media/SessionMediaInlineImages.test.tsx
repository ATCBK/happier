import * as React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { StyleSheet } from 'react-native';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionFileNativeTransferBoundary } from '@/components/sessions/files/sessionFileNativeTransferTestkit';
import { createSessionFilesViewFixture, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { transferMachine } from '@/components/sessions/files/sessionFileTransferTestkit';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { SessionMediaInlineImages } from './SessionMediaInlineImages';

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});
const fileSystem = vi.hoisted(() => ({ files: new Map<string, number[]>() }));
vi.mock('expo-file-system', async () => {
    const boundary = (await import('@/dev/testkit/mocks/expoFileSystem')).createExpoFileSystemFileMock();
    fileSystem.files = boundary.files;
    return boundary.module;
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('expo-image', () => ({
    Image: 'ExpoImage',
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ confirmResult: true }).module;
});

let transfer: ReturnType<typeof createSessionFileNativeTransferBoundary>;
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
let rejectDownloads = false;
beforeAll(prepareSessionFilesViewTestkit);
beforeEach(async () => {
    rejectDownloads = false;
    fileSystem.files.clear();
    transfer = createSessionFileNativeTransferBoundary();
    const serverIdentityId = 'srv_session_media_images';
    const boundary = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://session-file-views.test', serverIdentityId,
        accountId: 'alice', machineId: 'm1', actionId: 'daemon.filesystem.download', tokenEpoch: 0,
        execute: (input, { target }) => {
            if (target.kind !== 'machine') throw new Error('Expected a preview Machine');
            return rejectDownloads ? { success: false, error: 'not_found' }
                : transfer.rpc({ targetId: target.machineId,
                    method: getActionSpec('daemon.filesystem.download').bindings!.rpcMethod!, payload: { input } });
        },
    });
    const machine = transferMachine({ id: 'm1', storageMode: 'plain', installationId: boundary.machine.installationId,
        installationPublicKey: boundary.machine.installationPublicKey, replacedByMachineId: null, access: boundary.machine.access });
    const row = { ...boundary.machine, operationProtocolCapabilities: machine.operationProtocolCapabilities,
        operationProtocolCapabilitiesRevision: machine.operationProtocolCapabilitiesRevision,
        daemonState: encodePlainMachineStoredContent(machine.daemonState) };
    fixture = await createSessionFilesViewFixture({ sessionId: 's1', rootPath: '/repo', machine, serverIdentityId,
        credentials: { token: `e30.${Buffer.from(JSON.stringify({ sub: 'alice', provenance: { v: 1, kind: 'account', authority: 'present_user' }, tokenEpoch: 0 })).toString('base64url')}.signature` },
        machineCarrierOrigin: transfer.origin, rpc: transfer.rpc, request: async (url, init) => {
            const parsed = new URL(String(url));
            if (parsed.pathname === '/v1/machines') return Response.json([row]);
            if (parsed.pathname === '/v1/machines/m1') return Response.json({ machine: row });
            if (parsed.pathname.startsWith('/v1/actions/')) {
                const response = await boundary.handle(parsed, init);
                if (response) return response;
            }
            return transfer.request(url, init);
        } });
    fixture.storage.getState().applySettingsLocal({ filesImagePreviewCacheMaxEntries: 0, filesImagePreviewMaxBytes: 1_000_000 });
});

afterEach(async () => {
    standardCleanup();
    await fixture.dispose();
});

describe('SessionMediaInlineImages', () => {
    it('renders public media as inert metadata without invoking a preview resolver', async () => {
        const path = '.happier/uploads/generated/public.png';
        const screen = await renderScreen(
            <SessionMediaInlineImages
                sessionId="public"
                media={[{
                    id: 'public-image',
                    status: 'available',
                    name: 'public.png',
                    path,
                    mimeType: 'image/png',
                    sizeBytes: 42,
                    category: 'generated',
                    role: 'output',
                }]}
                onOpenPath={() => {
                    throw new Error('public media must not open a file');
                }}
                fileOpenEnabled={false}
                mediaPreviewEnabled={false}
            />,
        );

        const tile = screen.findByTestId(`message-session-media-inline-image:${path}`);
        expect(tile?.type).toBe('View');
        expect(tile?.props.onPress).toBeUndefined();
        expect(transfer.prepares).toEqual([]);
    });

    it('renders available video references as accessible file-opening media tiles', async () => {
        const { t } = await import('@/text');
        const onOpenPath = vi.fn();

        const screen = await renderScreen(
            <SessionMediaInlineImages
                sessionId="s1"
                media={[{
                    id: 'recording-1',
                    mediaKind: 'video',
                    status: 'available',
                    name: 'browser-recording.webm',
                    path: '.happier/uploads/artifacts/session-1/message-1/browser-recording.webm',
                    mimeType: 'video/webm',
                    sizeBytes: 2048,
                    category: 'tool-artifact',
                    role: 'output',
                } as any]}
                onOpenPath={onOpenPath}
                fileOpenEnabled
                mediaPreviewEnabled
            />,
        );

        const tile = screen.findByTestId('message-session-media-inline-video:.happier/uploads/artifacts/session-1/message-1/browser-recording.webm');

        expect(tile?.props.accessibilityRole).toBe('button');
        expect(tile?.props.accessibilityLabel).toBe(t('files.sessionMedia.toolArtifactVideoA11y', { name: 'browser-recording.webm' }));

        const { Modal } = await import('@/modal');
        vi.mocked(Modal.show).mockClear();
        screen.pressByTestId('message-session-media-inline-video:.happier/uploads/artifacts/session-1/message-1/browser-recording.webm');
        // The video opens in the Media stage; its "Open file" reaches the File page.
        expect(Modal.show).toHaveBeenCalledTimes(1);
        const [config] = vi.mocked(Modal.show).mock.calls[0] ?? [];
        expect(config?.props?.items).toHaveLength(1);
        expect(config?.props?.items[0]).toMatchObject({ kind: 'video', title: 'browser-recording.webm' });
        expect(onOpenPath).not.toHaveBeenCalled();
        config?.props?.items[0].openFile();
        expect(onOpenPath).toHaveBeenCalledWith('.happier/uploads/artifacts/session-1/message-1/browser-recording.webm');
    });

    it('renders unavailable media failure rows with translated accessible state', async () => {
        const { t } = await import('@/text');

        const screen = await renderScreen(
            <SessionMediaInlineImages
                sessionId="s1"
                media={[{
                    id: 'failure-0',
                    status: 'unavailable',
                    name: 'generated.png',
                    mimeType: 'image/png',
                    category: 'generated',
                    role: 'output',
                    failureCode: 'invalid_source_file',
                }]}
                onOpenPath={() => {}}
                fileOpenEnabled
                mediaPreviewEnabled
            />,
        );

        const tile = screen.findByTestId('message-session-media-inline-image-unavailable:failure-0');

        expect(tile?.props.accessibilityRole).toBe('image');
        expect(tile?.props.accessibilityLabel).toBe(t('files.sessionMedia.unavailableImageA11y', { name: 'generated.png' }));
        expect(screen.getTextContent()).toContain(t('files.sessionMedia.previewUnavailableA11y'));
    });

    it('exposes inline image tiles as accessible translated buttons', async () => {
        const { t } = await import('@/text');

        const screen = await renderScreen(
            <SessionMediaInlineImages
                sessionId="s1"
                media={[{
                    id: 'media-1',
                    name: 'diagram.png',
                    path: '.happier/uploads/generated/session-1/message-1/diagram.png',
                    mimeType: 'image/png',
                    sizeBytes: 42,
                    category: 'generated',
                    role: 'output',
                }]}
                onOpenPath={() => {}}
                fileOpenEnabled
                mediaPreviewEnabled
            />,
        );

        const tile = screen.findByTestId('message-session-media-inline-image:.happier/uploads/generated/session-1/message-1/diagram.png');

        expect(tile?.props.accessibilityRole).toBe('button');
        expect(tile?.props.accessibilityLabel).toBe(t('files.sessionMedia.generatedImageA11y', { name: 'diagram.png' }));
    });

    it('fills the tile and preserves aspect ratio when expo-image reports intrinsic dimensions', async () => {
        const path = '.happier/uploads/generated/session-1/message-1/wide.png';
        const screen = await renderScreen(
            <SessionMediaInlineImages
                sessionId="s1"
                media={[{
                    id: 'media-wide',
                    name: 'wide.png',
                    path,
                    mimeType: 'image/png',
                    sizeBytes: 42,
                    category: 'generated',
                    role: 'output',
                }]}
                onOpenPath={() => {}}
                fileOpenEnabled
                mediaPreviewEnabled
            />,
        );

        await vi.waitFor(() => expect(screen.findByTestId(`message-session-media-inline-image-preview:${path}`)?.type).toBe('ExpoImage'));
        const preview = screen.findByTestId(`message-session-media-inline-image-preview:${path}`);
        expect(preview?.type).toBe('ExpoImage');
        expect(preview?.props.contentFit).toBe('contain');
        expect(fileSystem.files.get(preview?.props.source.uri)).toEqual([97, 98, 99]);

        await act(async () => {
            preview?.props.onLoad({
                cacheType: 'none',
                source: {
                    url: 'blob:preview',
                    width: 1600,
                    height: 900,
                    mediaType: 'image/png',
                },
            });
        });

        const tile = screen.findByTestId(`message-session-media-inline-image:${path}`);
        expect(StyleSheet.flatten(tile?.props.style)).toMatchObject({ width: 220, height: 124 });
    });

    it('opens available previews using indexes that skip unavailable failure rows', async () => {
        const { Modal } = await import('@/modal');

        const screen = await renderScreen(
            <SessionMediaInlineImages
                sessionId="s1"
                media={[{
                    id: 'failure-0',
                    status: 'unavailable',
                    name: 'missing.png',
                    category: 'generated',
                    role: 'output',
                    failureCode: 'invalid_source_file',
                }, {
                    id: 'media-1',
                    status: 'available',
                    name: 'first.png',
                    path: '.happier/uploads/generated/session-1/message-1/first.png',
                    mimeType: 'image/png',
                    sizeBytes: 42,
                    category: 'generated',
                    role: 'output',
                }, {
                    id: 'media-2',
                    status: 'available',
                    name: 'second.png',
                    path: '.happier/uploads/generated/session-1/message-1/second.png',
                    mimeType: 'image/png',
                    sizeBytes: 43,
                    category: 'generated',
                    role: 'output',
                }]}
                onOpenPath={() => {}}
                fileOpenEnabled
                mediaPreviewEnabled
            />,
        );

        await vi.waitFor(() => expect(screen.findByTestId('message-session-media-inline-image-preview:.happier/uploads/generated/session-1/message-1/first.png')).not.toBeNull());
        vi.mocked(Modal.show).mockClear();
        screen.pressByTestId('message-session-media-inline-image:.happier/uploads/generated/session-1/message-1/first.png');

        expect(Modal.show).toHaveBeenCalledTimes(1);
        const [config] = vi.mocked(Modal.show).mock.calls[0] ?? [];
        expect(config?.props?.items).toHaveLength(2);
        expect(config?.props?.items.map((item: { kind: string }) => item.kind)).toEqual(['image', 'image']);
        expect(config?.props?.initialIndex).toBe(0);
    });

    it('exposes a translated unavailable hint when an inline image preview is missing', async () => {
        rejectDownloads = true;

        const { t } = await import('@/text');

        const screen = await renderScreen(
            <SessionMediaInlineImages
                sessionId="s1"
                media={[{
                    id: 'media-1',
                    name: 'input.png',
                    path: '.happier/uploads/attachments/session-1/message-1/input.png',
                    mimeType: 'image/png',
                    sizeBytes: 42,
                    category: 'attachment',
                    role: 'input',
                }]}
                onOpenPath={() => {}}
                fileOpenEnabled
                mediaPreviewEnabled
            />,
        );

        await vi.waitFor(() => expect(screen.findByTestId('message-session-media-inline-image:.happier/uploads/attachments/session-1/message-1/input.png')?.props.accessibilityHint)
            .toBe(t('files.sessionMedia.previewUnavailableA11y')));
        const tile = screen.findByTestId('message-session-media-inline-image:.happier/uploads/attachments/session-1/message-1/input.png');

        expect(tile?.props.accessibilityRole).toBe('button');
        expect(tile?.props.accessibilityLabel).toBeTruthy();
        expect(tile?.props.accessibilityHint).toBe(t('files.sessionMedia.previewUnavailableA11y'));
    });

    it('does not announce an unavailable image as actionable when file opening is unavailable', async () => {
        rejectDownloads = true;

        const path = '.happier/uploads/generated/session-1/message-1/missing.png';
        const screen = await renderScreen(
            <SessionMediaInlineImages
                sessionId="s1"
                media={[{
                    id: 'media-missing',
                    name: 'missing.png',
                    path,
                    mimeType: 'image/png',
                    sizeBytes: 42,
                    category: 'generated',
                    role: 'output',
                }]}
                onOpenPath={() => {
                    throw new Error('file opening is unavailable');
                }}
                fileOpenEnabled={false}
                mediaPreviewEnabled
            />,
        );

        await vi.waitFor(() => expect(screen.findByTestId(`message-session-media-inline-image:${path}`)?.props.accessibilityRole).toBe('image'));
        const tile = screen.findByTestId(`message-session-media-inline-image:${path}`);
        expect(tile?.props.accessibilityRole).toBe('image');
        expect(tile?.props.onPress).toBeUndefined();
    });
});
