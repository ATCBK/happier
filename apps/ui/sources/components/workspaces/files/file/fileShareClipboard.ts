import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

/** Explicit source retirement cannot fall back to another mounted surface's Account. */
export function resolveFileShareActionScope(source: ServerAccountScope | null | undefined, composer?: ServerAccountScope | null): ServerAccountScope | null {
    return source === undefined ? composer ?? null : source;
}

export type FileShareClipboardSource = Readonly<{
    relativePath: string;
    absolutePath: string | null;
    link: string | null;
}>;

export type FileShareClipboardIntent = Readonly<{ kind: 'path'; absolute?: boolean }> | Readonly<{ kind: 'link' }>;

export function buildFileShareClipboardRequest(source: FileShareClipboardSource, intent: FileShareClipboardIntent):
    Readonly<{ actionId: 'clipboard.write'; input: Readonly<{ text: string }> }> | null {
    const text = intent.kind === 'link' ? source.link : intent.absolute ? source.absolutePath : source.relativePath;
    return text === null ? null : { actionId: 'clipboard.write', input: { text } };
}
