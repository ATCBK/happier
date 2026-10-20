export type HunkReviewFile = Readonly<{ path: string; keys: readonly string[]; generated?: boolean; lockfile?: boolean; pending?: boolean }>;
export type HunkReviewCursor = Readonly<{ path: string; key: string | null }>;

/** Re-resolve a rendered action against the current content table. */
export function resolveHunkReviewUnit<T extends Readonly<{ key: string }>>(input: Readonly<{
    renderedScopeId: string; currentScopeId: string; key: string; units: readonly T[];
}>): T | null {
    if (input.renderedScopeId !== input.currentScopeId) return null;
    return input.units.find(unit => unit.key === input.key) ?? null;
}

/** Stable source order, with generated and lockfile content at the end. */
export function orderHunkReviewFiles(files: readonly HunkReviewFile[]): readonly HunkReviewFile[] {
    const isGenerated = (file: HunkReviewFile) => {
        const classified = classifyScmChangePath(file.path);
        return Boolean((file.generated ?? classified.generated) || (file.lockfile ?? classified.lockfile));
    };
    return files.filter(file => file.keys.length > 0 || file.pending).sort((left, right) =>
        Number(isGenerated(left)) - Number(isGenerated(right)));
}

export function moveHunkReviewCursor(files: readonly HunkReviewFile[], cursor: HunkReviewCursor | null,
    direction: 1 | -1, marked: ReadonlySet<string>, fileOnly = false): HunkReviewCursor | null {
    const ordered = orderHunkReviewFiles(files);
    if (ordered.length === 0) return null;
    const fileIndex = cursor ? ordered.findIndex(file => file.path === cursor.path) : -1;
    const file = ordered[fileIndex];
    const index = file && cursor?.key ? file.keys.indexOf(cursor.key) : -1;
    if (!file || index < 0) {
        const first = ordered[direction === 1 ? 0 : ordered.length - 1]!;
        return { path: first.path, key: first.keys[direction === 1 ? 0 : first.keys.length - 1] ?? null };
    }
    if (!fileOnly) {
        const key = file.keys[index + direction];
        if (key) return { path: file.path, key };
    }
    for (let distance = 1; distance <= ordered.length; distance += 1) {
        const candidate = ordered[(fileIndex + direction * distance + ordered.length) % ordered.length]!;
        if (candidate.pending && candidate.keys.length === 0) return { path: candidate.path, key: null };
        const keys = direction === 1 ? candidate.keys : [...candidate.keys].reverse();
        const key = keys.find(value => !marked.has(value));
        if (key) return { path: candidate.path, key };
    }
    const next = ordered[(fileIndex + direction + ordered.length) % ordered.length]!;
    return { path: next.path, key: next.keys[direction === 1 ? 0 : next.keys.length - 1] ?? null };
}

export function buildHunkReviewSummary(files: readonly HunkReviewFile[], marked: ReadonlySet<string>) {
    let reviewed = 0;
    let total = 0;
    let count = 0;
    const reviewedPaths = new Set<string>();
    for (const file of files) {
        if (file.keys.length === 0) continue;
        count += 1;
        total += file.keys.length;
        const kept = file.keys.filter(key => marked.has(key)).length;
        reviewed += kept;
        if (kept === file.keys.length) reviewedPaths.add(file.path);
    }
    return { reviewed, total, files: count, remaining: total - reviewed, reviewedPaths };
}
import { classifyScmChangePath } from '@happier-dev/protocol/scm/comparison';

