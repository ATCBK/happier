import type { ListReorderOutputV1 } from '@happier-dev/protocol/actions/listReorderAction';
import type { EntityDropOutcomeV1 } from '@happier-dev/protocol/plugins/ui';
import { t } from '@/text';

/** The shared projection of a settled domain reorder, after Action admission. */
export function entityReorderOutcome(result: ListReorderOutputV1): EntityDropOutcomeV1 {
    if (result.status === 'applied') return { status: 'applied' };
    return { status: result.status === 'unknown' ? 'unknown' : 'refused', reason: {
        code: 'reason' in result ? result.reason : 'reorder_unavailable',
        message: t(result.status === 'unknown' ? 'entityDragDrop.preview.unknownDetail' : 'entityDragDrop.reasons.gone'),
    } };
}
