import { decodeBase64 } from '@/encryption/base64';
import { isBinaryContent } from '@/scm/utils/filePresentation';
import { digest } from '@/platform/digest';

export type WorkspaceFileTextDecoding =
    | Readonly<{ kind: 'text'; text: string; hasBom: boolean; hash: string }>
    | Readonly<{ kind: 'notUtf8'; hash: string }>
    | Readonly<{ kind: 'binary' }>;

/** Restore only the BOM removed by the UTF8 decoder; callers own EOL policy. */
export function restoreWorkspaceFileTextBom(text: string, encoding?: Readonly<{ hasBom: boolean }>): string {
    return (encoding?.hasBom ? '\uFEFF' : '') + text;
}

/** Reconstruct an already-held complete text read for a byte-preserving export. */
export function reconstructWorkspaceFileTextBytes(input: Readonly<{
    text: string;
    complete: boolean;
    encoding?: Readonly<{ hasBom: boolean; editable: boolean; reason?: 'notUtf8' }>;
}>): Uint8Array | null {
    if (!input.complete || input.encoding?.editable !== true || input.encoding.reason === 'notUtf8') return null;
    return new TextEncoder().encode(restoreWorkspaceFileTextBom(input.text, input.encoding));
}

export async function decodeWorkspaceFileText(base64: string): Promise<WorkspaceFileTextDecoding> {
    const bytes = decodeBase64(base64);
    const hash = Array.from(await digest('SHA-256', bytes))
        .map(value => value.toString(16).padStart(2, '0')).join('');
    let text: string;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        return { kind: 'notUtf8', hash };
    }
    if (isBinaryContent(text)) return { kind: 'binary' };
    const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    return { kind: 'text', text, hasBom, hash };
}
