import React from 'react';

import { Modal } from '@/modal';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { useSetting } from '@/sync/store/hooks';
import { getStorage } from '@/sync/domains/state/storageStore';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { requireOneShotAccountSettingsMutationApplied } from '@/sync/engine/settings/syncSettings';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';

import {
    applySavedSecretReplacementIntent,
} from '@/sync/domains/settings/savedSecretMutations';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';

/**
 * Reference-aware replacement bridge for legacy SavedSecret editors. The
 * proposed array is converted into identity-local mutations and replayed
 * against each canonical Account Settings CAS winner.
 */
export function useSavedSecretsMutable(): readonly [
    SavedSecret[],
    (next: SavedSecret[]) => Promise<void>,
] {
    const secrets = useSetting('secrets');
    const expectedSettingsScope = useAccountSettingsScope();
    const replace = React.useCallback(async (next: SavedSecret[]) => {
        try {
            const current = getStorage().getState();
            if (!areServerAccountScopesEqual(current.settingsScope, expectedSettingsScope) || current.settingsVersion === null) {
                throw new Error('Account settings version is unavailable');
            }
            requireOneShotAccountSettingsMutationApplied(
                await getSyncSingleton().mutateAccountSettingsOnce({
                    expectedSettingsScope,
                    expectedSettingsVersion: current.settingsVersion,
                    mutate: (current) => ({
                        settings: applySavedSecretReplacementIntent({
                            current,
                            base: secrets,
                            proposed: next,
                        }).settings as Record<string, unknown>,
                        value: undefined,
                    }),
                }),
            );
        } catch (error) {
            Modal.alert(
                t('common.error'),
                error instanceof Error
                    ? error.message
                    : t('errors.operationFailed'),
            );
        }
    }, [expectedSettingsScope, secrets]);
    return [secrets, replace] as const;
}
