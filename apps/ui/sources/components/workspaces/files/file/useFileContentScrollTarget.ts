import * as React from 'react';
import type { FileViewerFindSnapshot } from '../details/useFileViewerFind';

/** The file content owner arbitrates deep-link and ephemeral Find scroll intent. */
export function useFileContentScrollTarget(jumpTarget: string | undefined, find?: Pick<FileViewerFindSnapshot, 'open' | 'lineTarget'>, rememberedTarget?: string, identity?: string): string | undefined {
    const intent = React.useMemo(() => ({ target: jumpTarget, retired: false, memoryRetired: false }), [identity]);
    React.useLayoutEffect(() => {
        if (intent.target !== jumpTarget) { intent.target = jumpTarget; intent.retired = false; }
        if (find?.open) intent.retired = true;
        if (find?.open || jumpTarget) intent.memoryRetired = true;
    }, [find?.open, jumpTarget, intent]);
    if (find?.open) return find.lineTarget ?? undefined;
    if (jumpTarget) return intent.target === jumpTarget && intent.retired ? undefined : jumpTarget;
    return intent.memoryRetired ? undefined : rememberedTarget;
}
