import { useHappierHitArea } from '@happier-dev/plugin-ui/presentation';
import { useUnistyles } from 'react-native-unistyles';

import { resolveMessageActionNeighbourGapPx } from './messageActionNeighbourGap';

/**
 * The hit area of one control in the transcript message-action row. The controls keep their drawn
 * size; under a finger the hit area reaches the touch target, sideways only into half of the gap to
 * the neighbouring control and vertically only into half of the room left before the next card, so
 * neighbours never overlap. The row's `marginRight` is the sideways gap: `s6`, or `s2` in the inverted layout.
 */
export function useMessageActionHitArea(invertedActionsLayout: boolean | undefined) {
    const { theme } = useUnistyles();
    const halfGap = (invertedActionsLayout ? theme.space.s2 : theme.space.s6) / 2;
    const vertical = resolveMessageActionNeighbourGapPx(theme) / 2;
    return useHappierHitArea({ restingStyle: () => null, hitReach: { left: halfGap, right: halfGap, top: vertical, bottom: vertical } });
}
