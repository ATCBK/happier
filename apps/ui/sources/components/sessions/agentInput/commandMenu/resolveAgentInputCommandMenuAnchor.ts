import type * as React from 'react';
import type { View } from 'react-native';

import type { CommandMenuAnchor } from '@/components/ui/commandMenu';
import type { CaretRect } from '@/hooks/ui/textInputCaretRect';

/**
 * Wide layouts hang the menu from the caret. A compact layout (lab xi-Pp) passes the composer card
 * as `cardRef` and the menu takes its left edge and width instead (the host passes
 * `matchAnchorWidth` with it), so the caret is ignored.
 */
export function resolveAgentInputCommandMenuAnchor(
    caretRect: CaretRect | null,
    fallbackRef: React.RefObject<View | null>,
    cardRef: React.RefObject<View | null> | null = null,
): CommandMenuAnchor {
    if (caretRect !== null && cardRef === null) {
        return {
            kind: 'rect',
            rect: {
                left: caretRect.left,
                top: caretRect.top,
                height: caretRect.height,
            },
            coordinateSpace: 'window',
        };
    }

    return { kind: 'view', ref: cardRef ?? fallbackRef };
}

