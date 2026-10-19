import * as React from 'react';
import { captureActiveServerAccountScopeLifetime, getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { getTempData, peekTempData, storeTempData } from '@/utils/sessions/tempDataStore';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';

type StoredWorkflowEditorDraftSeed<T> = Readonly<{
    kind: string;
    seed: T;
    lifetime: ReturnType<typeof captureActiveServerAccountScopeLifetime>;
    /** Addressed navigation rebinds at its destination; this identity grants no read/write authority. */
    scope?: ServerAccountScope;
}>;

/** Private draft navigation uses the existing temporary store and Account lifetime. */
export function storeWorkflowEditorDraftSeed<T>(kind: string, seed: T, accountLifetime?: ServerAccountScopeLifetime | null): string {
    return storeTempData({ kind, seed,
        lifetime: accountLifetime === undefined ? captureActiveServerAccountScopeLifetime() : null,
        ...(accountLifetime?.isCurrent() ? { scope: accountLifetime.scope } : {}),
    } satisfies StoredWorkflowEditorDraftSeed<T>);
}

/** Render may be replayed or discarded before commit, so intake is non-destructive. */
export function readWorkflowEditorDraftSeed<T>(kind: string, id: string, scope?: ServerAccountScope | null): T | null {
    const stored = peekTempData<StoredWorkflowEditorDraftSeed<T>>(id);
    if (stored?.kind !== kind) return null;
    return stored.scope ? areServerAccountScopesEqual(stored.scope, scope === undefined ? getActiveServerAccountScope() : scope)
        ? stored.seed : null : stored.lifetime?.isCurrent() ? stored.seed : null;
}

/** After adoption, only the mounted editor retains the private bytes. */
export function consumeWorkflowEditorDraftSeed(id: string): void {
    getTempData(id);
}

type WorkflowEditorDraftSeedState<T> = Readonly<{
    id: string | null;
    seed: T | null;
    lifetime: ReturnType<typeof captureActiveServerAccountScopeLifetime>;
    retired: boolean;
}>;

function readSeedState<T>(id: string | null, readSeed: (id: string, scope?: ServerAccountScope | null) => T | null, accountLifetime?: ServerAccountScopeLifetime | null): WorkflowEditorDraftSeedState<T> {
    const stored = id === null ? null : peekTempData<StoredWorkflowEditorDraftSeed<T>>(id);
    const seed = id === null || accountLifetime !== undefined
        && (!accountLifetime?.isCurrent() || !areServerAccountScopesEqual(stored?.scope ?? stored?.lifetime?.scope, accountLifetime.scope))
        ? null : readSeed(id, accountLifetime?.scope);
    return { id, seed, lifetime: seed === null ? null : accountLifetime === undefined ? captureActiveServerAccountScopeLifetime() : accountLifetime, retired: false };
}

/** One logical intake for every unsaved editor source, without consuming abandoned renders. */
export function useWorkflowEditorDraftSeed<T>(
    id: string | null,
    readSeed: (id: string, scope?: ServerAccountScope | null) => T | null,
    accountLifetime?: ServerAccountScopeLifetime | null,
): WorkflowEditorDraftSeedState<T> {
    const [stored, setStored] = React.useState(() => readSeedState(id, readSeed, accountLifetime));
    let adopted = stored;
    if (adopted.id !== id) {
        adopted = readSeedState(id, readSeed, accountLifetime);
        setStored(adopted);
    } else if (accountLifetime?.isCurrent() && adopted.lifetime !== accountLifetime
        && areServerAccountScopesEqual(adopted.lifetime?.scope, accountLifetime.scope)) {
        // A route's same-Account credential recheck replaces authority, not its adopted draft.
        adopted = { ...adopted, lifetime: accountLifetime };
        setStored(adopted);
    }
    const { lifetime, seed, id: adoptedId } = adopted;
    React.useEffect(() => {
        if (lifetime === null || accountLifetime !== undefined) return;
        const subscription = lifetime.onRetire(() => {
            setStored((current) => current.lifetime === lifetime
                ? { ...current, seed: null, retired: true }
                : current);
        });
        return () => subscription.dispose();
    }, [lifetime, accountLifetime]);
    React.useEffect(() => {
        // Capture the adopted handle, not later route props. Only a committed,
        // still-current editor takes custody of these private bytes.
        if (adoptedId !== null && seed !== null && lifetime?.isCurrent()) consumeWorkflowEditorDraftSeed(adoptedId);
    }, [adoptedId, lifetime, seed]);
    if (adoptedId === null) return adopted;
    if (accountLifetime !== undefined) return accountLifetime !== null
        && areServerAccountScopesEqual(lifetime?.scope, accountLifetime.scope) ? adopted : { ...adopted, seed: null, retired: true };
    return lifetime !== null && !lifetime.isCurrent()
        ? { ...adopted, seed: null, retired: true }
        : adopted;
}
