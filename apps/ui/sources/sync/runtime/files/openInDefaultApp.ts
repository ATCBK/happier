import type { NativeCacheFileSink } from './nativeCacheFileSink';

export type DesktopFileInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export async function createDesktopDownloadFileSink(input: Readonly<{
    fileName: string;
    invoke: DesktopFileInvoke;
}>): Promise<NativeCacheFileSink> {
    const path = await input.invoke('desktop_download_cache_create', { name: input.fileName });
    if (typeof path !== 'string' || !path) throw new Error('Desktop download path unavailable');
    let closed = false;
    let removed = false;
    const close = async () => {
        if (closed || removed) return;
        await input.invoke('desktop_download_cache_close', { path });
        closed = true;
    };
    return {
        fileUri: path,
        writeBytes: async bytes => {
            if (closed || removed) throw new Error('Desktop download file is closed');
            await input.invoke('desktop_download_cache_write', { path, bytes: Array.from(bytes) });
        },
        close,
        cleanup: async () => {
            if (removed) return;
            const errors: unknown[] = [];
            try { await close(); } catch (error) { errors.push(error); }
            try {
                await input.invoke('desktop_download_cache_remove', { path });
                removed = true;
            } catch (error) { errors.push(error); }
            if (errors.length === 1) throw errors[0];
            if (errors.length > 1) throw new AggregateError(errors, 'Desktop download cleanup failed');
        },
    };
}

export async function openInDefaultApp(input: Readonly<{ path: string; invoke: DesktopFileInvoke }>): Promise<void> {
    // The installed opener plugin checks the scoped capability. This is its
    // openPath command through the host's canonical IPC transport.
    await input.invoke('plugin:opener|open_path', { path: input.path });
}
