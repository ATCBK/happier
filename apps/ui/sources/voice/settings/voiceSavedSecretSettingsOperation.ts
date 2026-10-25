import { SettingsDeclarationValueV1Schema } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { resolveRequiredRecipientContractApprovalDigestV1 } from '@happier-dev/protocol/plugins/recipientContractV1';

import type { SettingOperationContext, SettingOperationResult } from '@/components/settings/catalog/settingDeclarations';
import { Modal } from '@/modal';
import { settingsParse } from '@/sync/domains/settings/settings';
import { refreshSavedSecretCatalog } from '@/sync/engine/settings/savedSecretCatalogEngine';
import { resolveSavedSecretReference } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import {
    approveAccountVoiceCredentialRecipientContract,
    createAccountVoiceCredentialBindingMutation,
    mutateScopedAccountVoiceCredentialSource,
    removeAccountVoiceCredential,
    resolveAccountVoiceCredentialApprovalDigest,
    resolveExactAccountVoiceCredentialSecretId,
    voiceCredentialSourceMutationContractDigest,
} from '@/voice/credentials/accountVoiceCredential';
import { createRecipientContractApproval } from '@/voice/credentials/recipientContractApprovalSummary';
import type { VoiceProviderRegistry, VoiceProviderRegistryEntry } from '@/voice/registry/providerRegistry';

/** Reference gestures share the picker owner; no credential value enters or leaves an Action. */
export async function invokeVoiceSavedSecretSettingsOperation(
    entry: VoiceProviderRegistryEntry,
    registry: VoiceProviderRegistry,
    context: SettingOperationContext,
): Promise<SettingOperationResult> {
    const input = context.input;
    if (input?.kind !== 'voice_saved_secret') return { status: 'unavailable', reason: 'operation_input_required' };
    const declaration = 'declaration' in entry ? entry.declaration : null;
    const scope = context.accountScope;
    if (!scope || !declaration?.credentials?.sources.some(source => source.kind === 'savedSecret')
        || declaration.credentials.slot.id !== input.credentialSlotId) {
        return { status: 'unavailable', reason: 'credential_source_unavailable' };
    }
    const contribution = { pluginId: entry.pluginId, localId: declaration.id };
    const sourceMutation = { contribution, credentialSlotId: input.credentialSlotId,
        expectedSettingsVersion: input.expectedSettingsVersion, selection: { kind: 'savedSecret' as const } };
    const contractDigest = voiceCredentialSourceMutationContractDigest(declaration, sourceMutation);
    const slot = entry.accountCredentialSlot;
    const recipient = slot?.recipientContract ? createRecipientContractApproval(slot.recipientContract) : null;
    const requiredDigest = slot ? resolveRequiredRecipientContractApprovalDigestV1(slot.recipientContract) : null;
    const isCurrent = () => {
        if (!context.isCurrent() || context.signal?.aborted) return false;
        const current = registry.get(entry.providerId);
        return current && 'declaration' in current && current.declaration
            && current.accountCredentialSlot?.recipientContractDigest === slot?.recipientContractDigest
            && voiceCredentialSourceMutationContractDigest(current.declaration, sourceMutation) === contractDigest;
    };
    if (!contractDigest || !isCurrent()
        || input.expectedRecipientContractDigest !== undefined && input.expectedRecipientContractDigest !== recipient?.digest) {
        return { status: 'unavailable', reason: 'credential_contract_changed' };
    }
    let settings = await context.readSettings();
    const resolve = (id: string) => resolveSavedSecretReference(scope, settings.secrets, id);
    const resolveExactId = () => resolveExactAccountVoiceCredentialSecretId({ settings, contribution,
        credentialSlotId: input.credentialSlotId, machineId: input.machineId });
    const retainedId = resolveExactId();
    const neededIds = input.operation === 'bind' ? [retainedId, input.secretId] : [retainedId];
    // The scoped catalog already owns material freshness. Mutations still prove
    // the exact reference at their canonical write boundary.
    if (neededIds.some(id => id && resolve(id).status !== 'ready')) {
        await refreshSavedSecretCatalog(scope);
        settings = await context.readSettings();
    }
    if (!isCurrent()) return { status: 'unavailable', reason: 'credential_contract_changed' };
    const exactId = resolveExactId();
    const previous = exactId ? resolve(exactId) : null;
    if (input.operation === 'inspect') return { status: 'completed', value: {
        secretId: exactId, revision: previous?.revision ?? null,
        recipient: recipient ? { digest: recipient.digest, summary: recipient.summary } : null,
    } };
    if (exactId !== input.expectedSecretId || (previous?.revision ?? null) !== input.expectedSecretUpdatedAt) {
        return { status: 'completed', value: { status: 'conflict' } };
    }
    const selectedId = input.operation === 'bind' ? input.secretId : exactId;
    const selected = selectedId ? resolve(selectedId) : null;
    if (!selectedId || !selected || selected.status !== 'ready' || selected.revision === null) return { status: 'unavailable', reason: 'saved_secret_record_unavailable' };
    const selectedRevision = selected.revision;
    const approvedRecipientContractDigest = resolveAccountVoiceCredentialApprovalDigest({ requiredRecipientContractDigest: requiredDigest, savedSecret: selected });
    if (requiredDigest && !approvedRecipientContractDigest) return { status: 'unavailable', reason: 'credential_contract_changed' };
    const confirmed = input.operation === 'remove'
        ? await Modal.confirm(t('settingsVoice.local.voiceCredential.deleteTitle'), t('settingsVoice.local.voiceCredential.deleteAccountBody'),
            { destructive: true, confirmText: t('common.remove') })
        : recipient ? await Modal.confirm(t('settingsVoice.externalCredentials.recipientApprovalTitle'), recipient.summary,
            { confirmText: t('settingsVoice.externalCredentials.recipientApprovalConfirm') }) : true;
    if (!confirmed) return { status: 'cancelled' };
    const referenceIsCurrent = () => isCurrent() && resolve(selectedId).fingerprint === selected.fingerprint;
    if (!referenceIsCurrent()) return { status: 'unavailable', reason: 'credential_contract_changed' };
    const binding = { contribution, credentialSlotId: input.credentialSlotId, machineId: input.machineId,
        secretId: selectedId, expectedSecretId: input.expectedSecretId, expectedSecretUpdatedAt: input.expectedSecretUpdatedAt,
        ...(approvedRecipientContractDigest ? { approvedRecipientContractDigest } : {}) };
    if (input.operation === 'bind') {
        // Choosing an existing reference explicitly activates it. Replacement
        // of a dormant key remains a separate resource-owner operation.
        const result = await mutateScopedAccountVoiceCredentialSource({ scope,
            mutation: { ...sourceMutation, savedSecretMutation: createAccountVoiceCredentialBindingMutation(binding) },
            expectedDeclaration: declaration,
            resolveCurrentDeclaration: () => referenceIsCurrent() ? declaration : null,
        });
        return { status: 'completed', value: SettingsDeclarationValueV1Schema.parse(result) };
    }
    const result = await sync.mutateAccountSettingsOnce({ expectedSettingsScope: scope, expectedSettingsVersion: input.expectedSettingsVersion,
        mutate: raw => {
            if (!referenceIsCurrent()) throw new Error('voice_credential_source_stale');
            const current = settingsParse(raw);
            const updated = input.operation === 'remove' ? removeAccountVoiceCredential({ ...binding, settings: current, expectedSecretId: selectedId,
                    expectedSecretUpdatedAt: selectedRevision })
                : approvedRecipientContractDigest ? approveAccountVoiceCredentialRecipientContract({ ...binding, settings: current,
                    expectedSecretId: selectedId, expectedSecretUpdatedAt: selectedRevision, approvedRecipientContractDigest })
                : { accountSettings: raw };
            return { settings: { ...updated.accountSettings }, value: undefined };
        },
    });
    const { value: _value, ...receipt } = result.status === 'applied' ? result : { ...result, value: undefined };
    return { status: 'completed', value: SettingsDeclarationValueV1Schema.parse(receipt) };
}
