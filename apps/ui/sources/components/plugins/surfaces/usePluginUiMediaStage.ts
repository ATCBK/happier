import * as React from 'react';
import type { PluginUiPresentationHost } from '@happier-dev/plugin-ui/advanced';

import { useMediaStage } from '@/components/ui/media/stage/useMediaStage';
import { resolveFileViewerKind } from '@/scm/utils/filePresentation';

/** Same-realm mounts adapt the already admitted URI, without acquiring or materializing it again. */
export function usePluginUiMediaStage(): NonNullable<PluginUiPresentationHost['mediaStage']> {
    const { open } = useMediaStage();
    return React.useMemo<NonNullable<PluginUiPresentationHost['mediaStage']>>(() => ({
        open(items, index) {
            open(items.map(item => ({
                kind: item.kind,
                title: item.title,
                alphaCapable: resolveFileViewerKind({ path: item.title, mimeType: item.mimeType }).alphaCapable,
                source: { enabled: true, mimeType: item.mimeType, source: { kind: 'uri', uri: item.uri } },
            })), index);
        },
    }), [open]);
}
