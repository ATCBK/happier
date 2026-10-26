import type { PersistedBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { parseLocalAccountSettings } from '@/sync/domains/settings/registry/local/localAccountSettingDefinitions';
import { createPersistentUiState, UiStatePersistenceError, usePersistentUiStateValue } from './persistentUiState';

export type LastUsedBackendSelection = Readonly<{
    lastUsedBackendTarget: PersistedBackendTargetRefV2 | null;
    lastUsedAgent: string | null;
}>;
const EMPTY_SELECTION: LastUsedBackendSelection = { lastUsedBackendTarget: null, lastUsedAgent: null };

function parseSelection(value: unknown): LastUsedBackendSelection {
    const { lastUsedBackendTarget, lastUsedAgent } = parseLocalAccountSettings(value);
    return { lastUsedBackendTarget, lastUsedAgent };
}

const selections = createPersistentUiState('new-session-target-v1', parseSelection);
const selectionKey = (scope: ServerAccountScope | null) => scope ? serverAccountScopeKeySuffix(scope) : 'legacy-unscoped';

export function readLastUsedBackendSelection(scope: ServerAccountScope | null): LastUsedBackendSelection {
    return selections.read(selectionKey(scope)) ?? EMPTY_SELECTION;
}

export function useLastUsedBackendSelectionForScope(scope: ServerAccountScope | null, enabled = true): LastUsedBackendSelection {
    return usePersistentUiStateValue(selections, enabled ? selectionKey(scope) : null) ?? EMPTY_SELECTION;
}

export function rememberLastUsedBackendSelection(scope: ServerAccountScope | null, selection: Readonly<{
    lastUsedBackendTarget: PersistedBackendTargetRefV2 | null;
    lastUsedAgent?: string | null;
}>): void {
    try {
        selections.set(selectionKey(scope), parseSelection({ ...readLastUsedBackendSelection(scope), ...selection }));
    } catch (error) {
        if (!(error instanceof UiStatePersistenceError)) throw error;
        console.warn('[new-session] Last-used Agent could not be persisted.');
    }
}

/** A predecessor Settings cache is an import source, never a competing writer. */
export function migrateLastUsedBackendSelection(scope: ServerAccountScope | null, settings: unknown): unknown {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return settings;
    const record = settings as Record<string, unknown>;
    if (!Object.hasOwn(record, 'lastUsedBackendTarget') && !Object.hasOwn(record, 'lastUsedAgent')) return settings;
    const key = selectionKey(scope);
    const seed = parseSelection(record);
    if ((seed.lastUsedBackendTarget !== null || seed.lastUsedAgent !== null) && selections.readStrict(key) === undefined) {
        selections.set(key, seed);
    }
    const { lastUsedBackendTarget: _target, lastUsedAgent: _agent, ...retained } = record;
    return retained;
}

/** Preserve the same local observation when the existing scope migration adopts a Home identity. */
export function migrateLastUsedBackendSelectionScope(from: ServerAccountScope | null, to: ServerAccountScope): void {
    const previous = selections.readStrict(selectionKey(from));
    if (previous && selections.readStrict(selectionKey(to)) === undefined) selections.set(selectionKey(to), previous);
}
