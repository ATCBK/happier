import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { FavoriteModelSelectionV1Schema } from '@/sync/domains/models/favoriteModelSelections';
import { RememberedEngineSelectionsByScopeV1Schema } from '@/sync/domains/session/authoring/rememberedEngineSelections';

const mutateAccountSettingsOnce = vi.hoisted(() => vi.fn());
const applyAuthoringMemoryDelta = vi.hoisted(() => vi.fn());
const settingsState = vi.hoisted(() => ({
    settingsVersion: 7 as number | null,
    settingsScope: { serverId: 'server-a', accountId: 'account-a' } as {
        serverId: string;
        accountId: string;
    } | null,
}));

vi.mock('@/sync/runtime/getSyncSingleton', () => ({
    getSyncSingleton: () => ({ mutateAccountSettingsOnce, applyAuthoringMemoryDelta }),
}));
vi.mock('@/sync/domains/state/storageStore', async () => {
    // Store-binding modules (voice Machine naming) read storage at import, so the stub is a complete store.
    const { createLiveStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
    const store = createLiveStorageStoreMock(() => settingsState);
    return { storage: store, getStorage: () => store };
});

import {
    useApplyRememberedEngineSelectionReplacementIntent,
} from './settingsWriters';

function favorite(modelId: string, updatedAt: number) {
    return FavoriteModelSelectionV1Schema.parse({
        selection: {
            v: 1,
            updatedAt,
            ref: {
                agentTargetKey: 'agent:happier.agent.codex/codex',
                providerConnectionId: null,
                modelId,
            },
        },
        addedAtMs: updatedAt,
    });
}

describe('session-authoring Settings writers', () => {
    beforeEach(() => {
        settingsState.settingsVersion = 7;
        settingsState.settingsScope = { serverId: 'server-a', accountId: 'account-a' };
        mutateAccountSettingsOnce.mockImplementation(async (input) => {
            const result = input.mutate({});
            return { status: 'applied', settingsVersion: 8, value: result.value };
        });
    });

    afterEach(() => {
        standardCleanup();
        vi.clearAllMocks();
    });


    it('routes remembered edits to authoring memory without writing the Account settings document', async () => {
        const base = RememberedEngineSelectionsByScopeV1Schema.parse({
            'server-a:backend:codex': {
                v: 1,
                modelSelection: favorite('gpt-5.4', 1).selection,
                updatedAt: 1,
            },
        });
        const proposed = {
            ...base,
            'server-a:backend:codex': {
                ...base['server-a:backend:codex']!,
                updatedAt: 2,
            },
        };
        const hook = await renderHook(() => useApplyRememberedEngineSelectionReplacementIntent());

        await hook.getCurrent()({ base, proposed });

        expect(mutateAccountSettingsOnce).not.toHaveBeenCalled();
        expect(applyAuthoringMemoryDelta).toHaveBeenCalledWith({
            rememberedEngineSelectionReplacement: { base, proposed },
        }, { expectedSettingsScope: { serverId: 'server-a', accountId: 'account-a' } });
    });

});
