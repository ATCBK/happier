import type { createPersistentUiState } from '@/sync/domains/state/persistentUiState';
import { z } from 'zod/mini';
import { PersistedPaneScopeSchema } from '@/components/appShell/panes/model/paneScopePersistenceSchema';

export const PersistedPaneScopesSchema = z._default(z.record(z.string(), PersistedPaneScopeSchema), {});

/** Seed the real keyed persistence owner; production has no test-only reset API. */
export function replacePersistentUiStateForTest<T>(
    state: ReturnType<typeof createPersistentUiState<T>>, values: Readonly<Record<string, T>>,
): void {
    for (const key of Object.keys(state.readAll())) if (!Object.hasOwn(values, key)) state.remove(key);
    for (const [key, value] of Object.entries(values)) state.set(key, value);
}
