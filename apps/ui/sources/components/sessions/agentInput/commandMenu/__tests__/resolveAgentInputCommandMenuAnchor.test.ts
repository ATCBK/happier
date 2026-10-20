import * as React from 'react';
import type { View } from 'react-native';
import { describe, expect, it } from 'vitest';

import type { CaretRect } from '@/hooks/ui/textInputCaretRect';
import { resolveAgentInputCommandMenuAnchor } from '../resolveAgentInputCommandMenuAnchor';

describe('resolveAgentInputCommandMenuAnchor', () => {
    it('returns a rect anchor without pre-offsetting the caret top', () => {
        const fallbackRef = React.createRef<View>();
        const caretRect: CaretRect = { left: 100, top: 200, height: 18 };

        const anchor = resolveAgentInputCommandMenuAnchor(caretRect, fallbackRef);

        expect(anchor).toEqual({
            kind: 'rect',
            rect: { left: 100, top: 200, height: 18 },
            coordinateSpace: 'window',
        });
    });

    it('falls back to the composer view anchor when no caret rect is available', () => {
        const fallbackRef = React.createRef<View>();

        const anchor = resolveAgentInputCommandMenuAnchor(null, fallbackRef);

        expect(anchor).toEqual({ kind: 'view', ref: fallbackRef });
    });

    it('anchors a compact layout to the composer card even while a caret rect is known', () => {
        const fallbackRef = React.createRef<View>();
        const cardRef = React.createRef<View>();
        const caretRect: CaretRect = { left: 100, top: 200, height: 18 };

        expect(resolveAgentInputCommandMenuAnchor(caretRect, fallbackRef, cardRef)).toEqual({ kind: 'view', ref: cardRef });
    });
});

