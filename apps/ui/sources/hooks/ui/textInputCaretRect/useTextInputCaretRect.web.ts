import * as React from 'react';

import type { CaretRect, UseTextInputCaretRectInput } from './useTextInputCaretRect.types';

export type { CaretRect, TextInputCaretRectHandle, UseTextInputCaretRectInput } from './useTextInputCaretRect.types';

/** Tracks viewport-relative editor geometry without reaching into its DOM implementation. */
export function useTextInputCaretRect(input: UseTextInputCaretRectInput): CaretRect | null {
    const { inputRef, selection, enabled = true } = input;
    const [rect, setRect] = React.useState<CaretRect | null>(null);

    React.useEffect(() => {
        const handle = inputRef.current;
        if (!enabled || !handle?.getCaretRect) {
            setRect(null);
            return;
        }

        const measure = () => {
            const next = handle.getCaretRect?.() ?? null;
            setRect((previous) => (
                previous && next
                && previous.left === next.left
                && previous.top === next.top
                && previous.height === next.height
                    ? previous
                    : next
            ));
        };

        measure();
        return handle.subscribeCaretRect?.(measure);
    }, [inputRef, selection?.start, selection?.end, enabled]);

    return enabled ? rect : null;
}
