import type { FindTextRange } from '@happier-dev/plugin-ui/presentation';

/** Publish row-local decorations with the existing identity whenever that row's paint is unchanged. */
export function reconcileCodeLineFindRanges(
    previous: ReadonlyMap<string, readonly FindTextRange[]>,
    next: Map<string, readonly FindTextRange[]>,
): ReadonlyMap<string, readonly FindTextRange[]> {
    let unchanged = previous.size === next.size;
    for (const [id, ranges] of next) {
        const prior = previous.get(id);
        if (prior && prior.length === ranges.length && ranges.every((range, index) => (
            range.start === prior[index]!.start && range.end === prior[index]!.end && range.current === prior[index]!.current
        ))) next.set(id, prior);
        else unchanged = false;
    }
    return unchanged ? previous : next;
}
