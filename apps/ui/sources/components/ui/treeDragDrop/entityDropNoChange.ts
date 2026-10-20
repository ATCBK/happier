/** A tab carried over its own pane leaves its placement unchanged. */
export const PANE_DROP_UNCHANGED_CODES: ReadonlySet<string> = new Set([
    'already_here', 'workspace_tab_already_here',
    'workspace_tab_cannot_split_own_pane',
]);

/** The carried widget is over its own place. */
export const WIDGET_MOVE_UNCHANGED_CODE = 'widget_position_unchanged';

/** Domain owners mark destinations that leave the carried entity where it is. */
export const ENTITY_DROP_UNCHANGED_CODES: ReadonlySet<string> = new Set([
    ...PANE_DROP_UNCHANGED_CODES,
    'no-change', 'same-position', 'board-no-change', WIDGET_MOVE_UNCHANGED_CODE,
    'already-kept', 'already-placed', 'board-already-here', 'unchanged',
]);
