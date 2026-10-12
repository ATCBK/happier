import * as React from 'react';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getTempData, peekTempData, storeTempData } from '@/utils/sessions/tempDataStore';

type StoredWorkflowEditorDraftSeed<T> = Readonly<{
    kind: string;
    seed: T;
    lifetime: ReturnType<typeof captureActiveServerAccountScopeLifetime>;
}>;

/** Private draft navigation uses the existing temporary store and Account lifetime. */
export function storeWorkflowEditorDraftSeed<T>(kind: string, seed: T): string {
    return storeTempData({ kind, seed, lifetime: captureActiveServerAccountScopeLifetime() } satisfies StoredWorkflowEditorDraftSeed<T>);
}

/** Render may be replayed or discarded before commit, so intake is non-destructive. */
export function readWorkflowEditorDraftSeed<T>(kind: string, id: string): T | null {
    const stored = peekTempData<StoredWorkflowEditorDraftSeed<T>>(id);
    return stored?.kind === kind && stored.lifetime?.isCurrent() ? stored.seed : null;
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

function readSeedState<T>(id: string | null, readSeed: (id: string) => T | null): WorkflowEditorDraftSeedState<T> {
    const seed = id === null ? null : readSeed(id);
    return { id, seed, lifetime: seed === null ? null : captureActiveServerAccountScopeLifetime(), retired: false };
}

/** One logical intake for every unsaved editor source, without consuming abandoned renders. */
export function useWorkflowEditorDraftSeed<T>(
    id: string | null,
    readSeed: (id: string) => T | null,
): WorkflowEditorDraftSeedState<T> {
    const [stored, setStored] = React.useState(() => readSeedState(id, readSeed));
    let adopted = stored;
    if (adopted.id !== id) {
        adopted = readSeedState(id, readSeed);
        setStored(adopted);
    }
    const { lifetime, seed, id: adoptedId } = adopted;
    React.useEffect(() => {
        if (lifetime === null) return;
        const subscription = lifetime.onRetire(() => {
            setStored((current) => current.lifetime === lifetime
                ? { ...current, seed: null, retired: true }
                : current);
        });
        return () => subscription.dispose();
    }, [lifetime]);
    React.useEffect(() => {
        // Capture the adopted handle, not later route props. Only a committed,
        // still-current editor takes custody of these private bytes.
        if (adoptedId !== null && seed !== null && lifetime?.isCurrent()) consumeWorkflowEditorDraftSeed(adoptedId);
    }, [adoptedId, lifetime, seed]);
    return lifetime !== null && !lifetime.isCurrent()
        ? { ...adopted, seed: null, retired: true }
        : adopted;
}
