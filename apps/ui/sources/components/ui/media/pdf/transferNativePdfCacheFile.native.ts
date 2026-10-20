import { encodeBase64 } from '@/encryption/base64';
import { transferPdfToWebView } from './pdfNativeTransfer';

/** Expo 55 FileHandle's readBytes/offset API keeps the host's binary residency to one measured slice. */
export async function transferNativePdfCacheFile(input: Readonly<{
    uri: string; sliceBytes: number; signal: AbortSignal; injectJavaScript(script: string): void;
}>): Promise<void> {
    const { File } = await import('expo-file-system');
    input.signal.throwIfAborted();
    const file = new File(input.uri);
    const handle = file.open();
    try {
        await transferPdfToWebView({ ...input, source: {
            getSize: async () => file.size,
            readBase64: async (offset, length) => {
                handle.offset = offset;
                return encodeBase64(handle.readBytes(length), 'base64');
            },
        } });
    } finally { handle.close(); }
}
