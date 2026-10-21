import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createExpoFileSystemFileMock } from '@/dev/testkit/mocks/expoFileSystem';

const boundary = vi.hoisted(() => ({ fileSystem: null as null | ReturnType<typeof createExpoFileSystemFileMock>,
    action: vi.fn<(input: { fileUri: string; action: string }) => Promise<{ canceled: boolean }>>() }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'android' }));
vi.mock('expo-file-system', async () => {
    boundary.fileSystem = (await import('@/dev/testkit/mocks/expoFileSystem')).createExpoFileSystemFileMock();
    return boundary.fileSystem.module;
});
// The adapter is the native chooser/intent boundary; custody and file copying remain real.
vi.mock('./nativeFileActions', () => ({ performAndroidFileAction: boundary.action }));

beforeEach(async () => {
    await import('expo-file-system');
    boundary.fileSystem!.files.clear();
    boundary.fileSystem!.copies.mockClear();
    boundary.fileSystem!.writes.mockClear();
    boundary.fileSystem!.files.set('file:///cache/current.mp4', [1, 2, 3]);
    boundary.action.mockReset().mockResolvedValue({ canceled: false });
});

describe('completed file handoff', () => {
    it('copies a local preview without reading video bytes into JS and retains only the handed-off Android copy', async () => {
        const { saveFileUri } = await import('./saveFileBytes');
        await expect(saveFileUri({ uri: 'file:///cache/current.mp4', fileName: 'clip.mp4', mimeType: 'video/mp4', action: 'open' })).resolves.toBe('saved');
        const handoff = boundary.action.mock.calls[0]![0];
        expect(handoff.action).toBe('open');
        expect(handoff.fileUri).not.toBe('file:///cache/current.mp4');
        expect(boundary.fileSystem!.files.get(handoff.fileUri)).toEqual([1, 2, 3]);
        expect(boundary.fileSystem!.files.get('file:///cache/current.mp4')).toEqual([1, 2, 3]);
        expect(boundary.fileSystem!.copies).toHaveBeenCalledOnce();
        expect(boundary.fileSystem!.writes).not.toHaveBeenCalled();
    });

    it('cleans up its local copy when the chooser cancels without deleting the preview', async () => {
        boundary.action.mockResolvedValue({ canceled: true });
        const { saveFileUri } = await import('./saveFileBytes');
        await expect(saveFileUri({ uri: 'file:///cache/current.mp4', fileName: 'clip.mp4', mimeType: 'video/mp4' })).resolves.toBe('canceled');
        expect([...boundary.fileSystem!.files.keys()]).toEqual(['file:///cache/current.mp4']);
    });
});
