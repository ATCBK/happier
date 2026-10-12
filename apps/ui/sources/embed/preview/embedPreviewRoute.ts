import type { FrameBridgeIdentityV1 } from '@happier-dev/protocol/embed';

/** The Settings live preview route (plan 04 §4.5): the real embedded chat with sample messages. */
export const EMBED_PREVIEW_PATH = '/embed/preview';

export type EmbedPreviewParams = Readonly<{
    identity: FrameBridgeIdentityV1;
    reduceMotion: boolean;
    newChat: boolean;
    /** Shows what open chats show while an enforced access edit makes them reconnect (lab D2). */
    reconnecting: boolean;
    /** The draft's access: without Send the chat is view-only, without Approve requests are not answerable. */
    send: boolean;
    approve: boolean;
}>;

export function buildEmbedPreviewSearch(params: EmbedPreviewParams): string {
    const search = new URLSearchParams({ i: params.identity.instanceId, n: params.identity.mountNonce });
    if (params.reduceMotion) search.set('reduceMotion', '1');
    if (params.newChat) search.set('newChat', '1');
    if (params.reconnecting) search.set('reconnecting', '1');
    if (!params.send) search.set('send', '0');
    if (!params.approve) search.set('approve', '0');
    return search.toString();
}

export function readEmbedPreviewParams(search: string): EmbedPreviewParams | null {
    const params = new URLSearchParams(search);
    const instanceId = params.get('i')?.trim() ?? '';
    const mountNonce = params.get('n')?.trim() ?? '';
    if (!instanceId || !mountNonce) return null;
    return {
        identity: { instanceId, mountNonce },
        reduceMotion: params.get('reduceMotion') === '1',
        newChat: params.get('newChat') === '1',
        reconnecting: params.get('reconnecting') === '1',
        send: params.get('send') !== '0',
        approve: params.get('approve') !== '0',
    };
}
