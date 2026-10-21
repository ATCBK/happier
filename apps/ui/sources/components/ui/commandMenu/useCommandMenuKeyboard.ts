import * as React from 'react';

/**
 * Returns a stable `handleKey(event)` that returns `true` if the key was consumed.
 * Wired by hosts inside their existing `handleKeyPress` so the host preserves precedence.
 * Recognises exactly the existing AgentInput autocomplete key contract:
 * ArrowUp/Down (wraps), Enter, Tab (no-shift = select), Escape (close).
 * Shift+Tab returns false so the host can run its existing permission-mode shortcut.
 *
 * A menu with kind tabs passes `onTab`: Tab then moves to the next tab instead of choosing a row.
 * A menu showing only its empty state passes `selectable: false`: it keeps Escape and leaves Enter,
 * Tab and the arrows to the composer, so a word that merely starts with a trigger can still be sent.
 */
export function useCommandMenuKeyboard(input: Readonly<{
    open: boolean;
    onMoveUp: () => void;
    onMoveDown: () => void;
    onSelect: () => void;
    onClose: () => void;
    onTab?: () => void;
    selectable?: boolean;
}>): { handleKey: (event: { key: string; shiftKey?: boolean; isComposing?: boolean }) => boolean } {
    const { open, onMoveUp, onMoveDown, onSelect, onClose, onTab, selectable = true } = input;

    const handleKey = React.useCallback(
        (event: { key: string; shiftKey?: boolean; isComposing?: boolean }): boolean => {
            if (!open || event.isComposing === true) return false;
            const cyclesTabs = event.key === 'Tab' && event.shiftKey !== true && onTab !== undefined;
            if (!selectable && event.key !== 'Escape' && !cyclesTabs) return false;

            switch (event.key) {
                case 'ArrowDown':
                    onMoveDown();
                    return true;
                case 'ArrowUp':
                    onMoveUp();
                    return true;
                case 'Enter':
                    onSelect();
                    return true;
                case 'Tab':
                    if (event.shiftKey) return false;
                    if (onTab) onTab();
                    else onSelect();
                    return true;
                case 'Escape':
                    onClose();
                    return true;
                default:
                    return false;
            }
        },
        [open, onMoveUp, onMoveDown, onSelect, onClose, onTab, selectable],
    );

    return React.useMemo(() => ({ handleKey }), [handleKey]);
}
