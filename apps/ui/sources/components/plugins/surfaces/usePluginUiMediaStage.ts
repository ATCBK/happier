import * as React from 'react';
import type { PluginUiPresentationHost } from '@happier-dev/plugin-ui/advanced';

import { useMediaStage } from '@/components/ui/media/stage/useMediaStage';

/** Same-realm mounts adapt the already admitted URI, without acquiring or materializing it again. */
export function usePluginUiMediaStage(): NonNullable<PluginUiPresentationHost['mediaStage']> {
    const { open } = useMediaStage();
    return React.useMemo<NonNullable<PluginUiPresentationHost['mediaStage']>>(() => ({
        open(items, index) {
            open(items.map(item => ({
                kind: item.kind,
                title: item.title,
                source: { enabled: true, source: { kind: 'uri', uri: item.uri } },
            })), index);
        },
    }), [open]);
}
