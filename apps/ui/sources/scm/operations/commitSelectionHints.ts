import type { ScmCommitSelectionPatch } from '@/sync/domains/state/storageTypes';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { isAtomicCommitStrategy, type ScmCommitStrategy } from '@/scm/settings/commitStrategy';

export function buildCommitSelectionPathHints(input: Readonly<{
    commitSelectionPaths: readonly string[];
    commitSelectionPatches: readonly ScmCommitSelectionPatch[];
}>): string[] {
    const selected = new Set<string>();
    for (const path of input.commitSelectionPaths) {
        if (path.length > 0) selected.add(path);
    }
    for (const patch of input.commitSelectionPatches) {
        if (patch.path.length > 0) selected.add(patch.path);
    }
    return Array.from(selected).sort((a, b) => a.localeCompare(b));
}

export function countCommitSelectionItems(input: Readonly<{
    commitSelectionPaths: readonly string[];
    commitSelectionPatches: readonly ScmCommitSelectionPatch[];
}>): number {
    return buildCommitSelectionPathHints(input).length;
}

export function isFileSelectedForCommit(input: Readonly<{
    commitStrategy: ScmCommitStrategy;
    file: ScmFileStatus;
    atomicSelectionPaths: ReadonlySet<string>;
}>): boolean {
    return isAtomicCommitStrategy(input.commitStrategy)
        ? input.atomicSelectionPaths.has(input.file.fullPath)
        : input.file.isIncluded === true;
}
