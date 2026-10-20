import { Platform } from 'react-native';

import { t } from '@/text';

import { downloadWebFile } from './downloadWebFile';
import { createNativeCacheFileSink, shareNativeCacheFile } from './nativeCacheFileSink';

/**
 * Hands finished bytes to the person: a browser download on web, the platform share sheet elsewhere.
 * Resolves `canceled` when `isCurrent` turned false before the hand-off; throws when sharing is unavailable.
 */
export async function saveFileBytes(input: Readonly<{
    bytes: Uint8Array;
    fileName: string;
    mimeType: string;
    isCurrent?: () => boolean;
    onHandoff?: () => void;
    action?: 'save' | 'open' | 'share';
}>): Promise<'saved' | 'canceled'> {
    if (Platform.OS === 'web') {
        if (input.isCurrent?.() === false) return 'canceled';
        input.onHandoff?.();
        downloadWebFile(new Blob([new Uint8Array(input.bytes)], { type: input.mimeType }), input.fileName, async () => {});
        return 'saved';
    }
    const sink = await createNativeCacheFileSink({ directoryName: 'happier-downloads', fileName: input.fileName });
    if (!sink.ok) throw new Error(sink.error);
    let retainCacheFile = false;
    try {
        await sink.writeBytes(input.bytes);
        await sink.close();
        const shared = await shareNativeCacheFile({
            fileUri: sink.fileUri, name: input.fileName, mimeType: input.mimeType, isCurrent: input.isCurrent,
            action: input.action, onHandoff: input.onHandoff,
        });
        if (shared.status === 'canceled') return 'canceled';
        if (shared.status === 'unavailable') throw new Error(t('files.fileSharingUnavailable'));
        retainCacheFile = shared.retainCacheFile;
        return 'saved';
    } finally {
        if (!retainCacheFile) await sink.cleanup();
    }
}
