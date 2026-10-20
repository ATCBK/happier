/** One contiguous edit preserves unaffected tracked ranges and one undo step. */
export function minimalCodeEditorEdit(before: string, after: string): { from: number; to: number; insert: string } | null {
    if (before === after) return null;
    let from = 0;
    while (from < before.length && from < after.length && before[from] === after[from]) from++;
    let to = before.length;
    let afterEnd = after.length;
    while (to > from && afterEnd > from && before[to - 1] === after[afterEnd - 1]) { to--; afterEnd--; }
    return { from, to, insert: after.slice(from, afterEnd) };
}
