import type { ClientEncryptionRequirement } from '@happier-dev/protocol/encryption/clientEncryptionRequirement';
import { getStorage } from '@/sync/domains/state/storageStore';
import { loadAccountSettings, saveAccountSettings } from '@/sync/domains/state/accountSettingsPersistence';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { settingsParse } from '@/sync/domains/settings/settings';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';

/** The answering client owns its scoped minimum; the Account CAS owns the synced preference. */
export async function setClientEncryptionRequirement(
    account: Pick<LazyActionAccountContext, 'accountLifetime' | 'assertCurrent' | 'resolveAccountMode' | 'mutateRawSettings'>,
    enabled: boolean,
): Promise<'updated' | 'needs_e2ee'> {
    account.assertCurrent();
    if (enabled && await account.resolveAccountMode() !== 'e2ee') return 'needs_e2ee';
    account.assertCurrent();
    const requirement: ClientEncryptionRequirement = enabled ? 'require_e2ee' : 'follow_account';
    const scope = account.accountLifetime.scope;
    const pin = () => {
        account.assertCurrent();
        const state = getStorage().getState();
        if (areAccountSettingsScopesEqual(scope, state.settingsScope)) {
            state.applySettingsLocal({ clientEncryptionRequirementLocalV1: requirement });
        } else {
            const persisted = loadAccountSettings(scope);
            saveAccountSettings(scope, settingsParse({ ...settingsParse(persisted.settings),
                clientEncryptionRequirementLocalV1: requirement }), persisted.version ?? 0);
        }
    };
    // A failed upload may strengthen the local minimum, but can never weaken it.
    if (enabled) pin();
    await account.mutateRawSettings(raw => ({ ...raw, clientEncryptionRequirementV1: requirement }));
    if (!enabled) pin();
    return 'updated';
}
