import * as React from 'react';

import { useKeyboardShortcutHandlers } from './KeyboardShortcutProvider';
import type { KeyboardShortcutHandlers } from './runtime';

export type SessionListSpaceKeyboardCommands = Readonly<{
    /** The existing column/surface focus owner decides which list receives commands. */
    enabled: boolean;
    selectOrdinal?: (ordinal: number) => boolean;
    openFilter?: () => void;
}>;

export function useSessionListSpaceKeyboardCommands(input: SessionListSpaceKeyboardCommands): void {
    const { enabled, selectOrdinal, openFilter } = input;
    const handlers = React.useMemo<KeyboardShortcutHandlers>(() => {
        if (!enabled) return {};
        const commands: KeyboardShortcutHandlers = {};
        if (openFilter) commands['sessionList.filter.open'] = openFilter;
        if (selectOrdinal) {
            for (const ordinal of [1, 2, 3, 4, 5, 6, 7, 8, 9] as const) {
                commands[`sessionList.space.select${ordinal}`] = () => selectOrdinal(ordinal) ? 'handled' : 'pass';
            }
        }
        return commands;
    }, [enabled, openFilter, selectOrdinal]);
    useKeyboardShortcutHandlers(handlers);
}
