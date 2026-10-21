/** Browser code renderers commit navigation on click, after the platform has classified the gesture.
 * A touch release may resolve a position, but must not open an overlay before its compatibility click.
 */
export function resolveCodeTokenPress(
    event: Readonly<{ type?: string; button?: number; metaKey?: boolean; ctrlKey?: boolean }>,
    touchPending: boolean,
    selectionActive: boolean,
): 'modifier' | 'touch' | null {
    if (event.type !== 'click' || (event.button ?? 0) !== 0) return null;
    if (event.metaKey || event.ctrlKey) return 'modifier';
    return touchPending && !selectionActive ? 'touch' : null;
}
import type { Rect } from '../editor/codeEditorTypes';

export type CodeTokenPointer = Readonly<{ lineId: string; offset16: number; newLine: number; rect: Rect }>;

