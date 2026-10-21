import { useCallback, useId } from 'react';
import type { EntityDragItemV1 } from '@happier-dev/protocol/plugins/ui';
import { useSessionListMoveSheet } from '@/components/sessions/shell/move-sheet/useSessionListMoveSheet';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { useEntityDragDropRuntime } from './entityDragDropHooks';

/** Row-menu adapter to the same staged chooser and composer target used by pointer/keyboard carries. */
export function useEntityComposerMention() {
    const runtime = useEntityDragDropRuntime();
    const sourceId = useId();
    const { openMoveSheet } = useSessionListMoveSheet();
    return useCallback((item: EntityDragItemV1, title: string) => openMoveSheet({
        runtime, sourceLabel: title, composerOnly: true,
        prepareSource: () => ({ sourceId, dispose: runtime.registerSource({ id: sourceId, scope: item.scope,
            getItem: () => item, describe: () => ({ title }),
            isCurrent: () => areServerAccountScopesEqual(item.scope, getActiveServerAccountScope()),
        }) }),
    }), [openMoveSheet, runtime, sourceId]);
}
