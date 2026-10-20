import { FileChangesScopeSchema, type FileChangesScope } from '@happier-dev/protocol/scm';
import type { SessionScmReviewComparison } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';

export function fileChangesScopeOfComparison(comparison: SessionScmReviewComparison | undefined): FileChangesScope | null {
    if (!comparison) return null;
    if (comparison.kind === 'turnCheckpoint') return comparison.turnId ? { kind: 'turn', turnId: comparison.turnId } : null;
    return comparison.kind === 'session' || comparison.kind === 'workingTree' ? { kind: comparison.kind } : null;
}

export function fileChangesComparisonOfScope(scope: FileChangesScope): SessionScmReviewComparison {
    return scope.kind === 'turn' ? { kind: 'turnCheckpoint', turnId: scope.turnId } : { kind: scope.kind };
}

/** Tolerant persisted-state reader; Action input admission remains strict at its schema. */
export function readFileChangesScope(value: unknown): FileChangesScope | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const parsed = FileChangesScopeSchema.safeParse(record.kind === 'turn'
        ? { kind: record.kind, turnId: record.turnId } : { kind: record.kind });
    return parsed.success ? parsed.data : null;
}

/** One selection policy for UI scope, live-diff admission and captured evidence. */
export function resolveFileChangesScope(input: Readonly<{
    storedScope?: unknown;
    initialChanges?: SessionScmReviewComparison;
    sessionId?: string | null;
}>) {
    const current = readFileChangesScope(input.storedScope) ?? fileChangesScopeOfComparison(input.initialChanges)
        ?? (input.sessionId ? { kind: 'session' as const } : { kind: 'workingTree' as const });
    const openingScope = fileChangesScopeOfComparison(input.initialChanges);
    const selector = openingScope && JSON.stringify(openingScope) === JSON.stringify(current)
        ? input.initialChanges! : fileChangesComparisonOfScope(current);
    return { current, selector, capture: current.kind !== 'workingTree' };
}
