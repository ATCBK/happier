import {
    ConnectedAccountCatalogRowMutationV1Schema, ConnectedAccountCatalogContentV1Schema, parseStoredConnectedAccountCatalogContentV1,
    StoredConnectedAccountCatalogContentV1Schema,
    assertConnectedAccountCatalogContentForModeV1, buildConnectedAccountCatalogPhysicalKeyV1,
    listConnectedConfigurationCatalogSavedSecretRefsV1,
    type ConnectedAccountCatalogContentV1, type ConnectedAccountCatalogKeyV1, type ConnectedAccountCatalogRowMutationV1,
    type ConnectedAccountCatalogRowMutationResponseV1,
    type StoredConnectedAccountCatalogContentV1,
} from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { listSavedSecretVoiceCredentialMutationReferencesV1, AccountSettingsSavedSecretMutationError } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { validateSavedSecretResourceReferencesInTx } from '@/app/account/savedSecrets/savedSecretResourceService';
import { acquireAccountEncryptionTransitionFenceInTx } from '@/app/encryption/accountEncryptionTransition';
import { openPlainAccountSettingsDbValue } from '@/app/encryption/accountSettingsStorage';
import { writeAccountSettingsInTx } from '@/app/accountSettings/writeAccountSettingsInTx';
import { inTx, transactionResult, type TransactionResult, type Tx } from '@/storage/inTx';
import type { TeamOperationAuthenticationContext } from '@/app/teams/actorContext';
import { mutateReservedAccountScopedKvRowInTx, readReservedAccountScopedKvRowInTx,
    type ReservedAccountScopedKvRowDomain } from '@/app/kv/reservedAccountScopedKvRow';

export function connectedAccountCatalogRowDomain(key: ConnectedAccountCatalogKeyV1): ReservedAccountScopedKvRowDomain<ConnectedAccountCatalogContentV1> {
    return {
        label: `Connected Account ${key} catalog`,
        parseStoredEnvelope(value) {
            const parsed = parseStoredConnectedAccountCatalogContentV1(value);
            return parsed && (parsed.t !== 'plain' || parsed.v.key === key) ? parsed : null;
        },
        parseCandidateEnvelope(value) {
            const parsed = ConnectedAccountCatalogContentV1Schema.safeParse(value);
            return parsed.success && (parsed.data.t !== 'plain' || parsed.data.v.key === key)
                && parseStoredConnectedAccountCatalogContentV1(parsed.data) ? parsed.data : null;
        },
        assertEnvelopeForMode(content, mode) { assertConnectedAccountCatalogContentForModeV1(content, mode, key); },
    };
}
function connectedAccountCatalogRowReadDomain(key: ConnectedAccountCatalogKeyV1): ReservedAccountScopedKvRowDomain<StoredConnectedAccountCatalogContentV1> {
    const complete = connectedAccountCatalogRowDomain(key);
    return {
        label: complete.label,
        parseStoredEnvelope(value) {
            const parsed = StoredConnectedAccountCatalogContentV1Schema.safeParse(value);
            if (!parsed.success) return null;
            if (parsed.data.t === 'plain') {
                const record = parsed.data.v;
                if (record === null || typeof record !== 'object' || Array.isArray(record) || !('key' in record) || record.key !== key) return null;
            }
            return parsed.data;
        },
        parseCandidateEnvelope: complete.parseCandidateEnvelope,
        assertEnvelopeForMode(content, mode) { assertConnectedAccountCatalogContentForModeV1(content, mode, key); },
    };
}
export function markConnectedAccountCatalogRowChangedInTx(tx: Tx,
    input: Readonly<{ accountId: string; key: ConnectedAccountCatalogKeyV1; revision: number }>): ReturnType<typeof markAccountChanged> {
    return markAccountChanged(tx, { accountId: input.accountId, kind: 'account', entityId: buildConnectedAccountCatalogPhysicalKeyV1(input.key),
        hint: { connectedAccountCatalog: true, key: input.key, revision: input.revision } });
}
export async function readConnectedAccountCatalogRowInTx(tx: Tx, input: Readonly<{ accountId: string; key: ConnectedAccountCatalogKeyV1 }>) {
    const result = await readReservedAccountScopedKvRowInTx(tx, { accountId: input.accountId,
        physicalKey: buildConnectedAccountCatalogPhysicalKeyV1(input.key), domain: connectedAccountCatalogRowReadDomain(input.key) });
    if (result.status !== 'present') return result;
    return { status: 'present' as const, revision: result.revision, content: result.envelope };
}
class ConnectedAccountCatalogPairedMutationRejected extends Error {
    constructor(readonly result: ConnectedAccountCatalogRowMutationResponseV1) { super('Connected Account paired mutation rejected'); }
}
type MutationInput = Readonly<{ accountId: string; key: ConnectedAccountCatalogKeyV1;
    authentication?: TeamOperationAuthenticationContext }> & ConnectedAccountCatalogRowMutationV1;
type MutationSuccess = Extract<ConnectedAccountCatalogRowMutationResponseV1, { status: 'updated' }>;
type MutationInTxResponse = Exclude<ConnectedAccountCatalogRowMutationResponseV1, { status: 'updated' }>
    | (Omit<MutationSuccess, 'cursor'> & TransactionResult<MutationSuccess>);

/** One catalog revision admits membership and references; the existing secret owner validates resource currentness. */
export async function mutateConnectedAccountCatalogRowInTx(tx: Tx, input: MutationInput): Promise<MutationInTxResponse> {
    const { accountId, key, authentication, ...candidate } = input;
    const mutation = ConnectedAccountCatalogRowMutationV1Schema.parse(candidate);
    if (mutation.content?.t === 'plain' && mutation.content.v.key !== key) return { status: 'invalid-stored-content' };
    const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, accountId, "content");
    if (fence.status === 'account_not_found') return { status: 'account-not-found' };
    if (fence.status === 'account_inconsistent') return { status: 'account-inconsistent', reason: fence.reason };
    if (mutation.sourceSettingsVersion !== undefined && fence.account.settingsVersion !== mutation.sourceSettingsVersion) {
        return { status: 'settings-conflict', revision: fence.account.settingsVersion };
    }
    if (mutation.settingsMutation && fence.account.settingsVersion !== mutation.settingsMutation.expectedSettingsVersion) {
        return { status: 'settings-conflict', revision: fence.account.settingsVersion };
    }
    const rowReferences = mutation.content?.t === 'plain'
        ? mutation.content.v.key === 'configurations'
            ? listConnectedConfigurationCatalogSavedSecretRefsV1(mutation.content.v.value).map(reference => reference.secretId)
            : []
        : [];
    const pairedReferences: string[] = [];
    if (fence.account.currentness.encryptionMode === 'plain' && mutation.settingsMutation?.content?.t === 'plain') {
        const current = openPlainAccountSettingsDbValue({ accountId, dbValue: fence.account.settings });
        try {
            pairedReferences.push(...listSavedSecretVoiceCredentialMutationReferencesV1(
                current?.t === 'plain' ? current.v : {}, mutation.settingsMutation.content.v,
                { requestedReferences: mutation.referencedSavedSecretIds }));
        } catch (error) {
            if (error instanceof AccountSettingsSavedSecretMutationError) return { status: 'invalid-reference' };
            throw error;
        }
    }
    const references = fence.account.currentness.encryptionMode === 'plain'
        ? [...new Set([...rowReferences, ...pairedReferences])] : mutation.referencedSavedSecretIds;
    if (fence.account.currentness.encryptionMode === 'plain' && (references.length !== mutation.referencedSavedSecretIds.length
        || references.some(reference => !mutation.referencedSavedSecretIds.includes(reference)))) return { status: 'invalid-reference' };
    if (!await validateSavedSecretResourceReferencesInTx(tx, { accountId, authentication, references,
        savedSecretRevisions: mutation.savedSecretRevisions ?? [] })) return { status: 'invalid-reference' };
    const result = await mutateReservedAccountScopedKvRowInTx(tx, { accountId, physicalKey: buildConnectedAccountCatalogPhysicalKeyV1(key),
        expectedRevision: mutation.expectedRevision, envelope: mutation.content, domain: connectedAccountCatalogRowDomain(key),
        markChanged: ({ tx: changeTx, revision }) => markConnectedAccountCatalogRowChangedInTx(changeTx, { accountId, key, revision }) });
    if (result.status !== 'updated' || !mutation.settingsMutation) return result;
    const settings = await writeAccountSettingsInTx({ tx, accountId, expectedVersion: mutation.settingsMutation.expectedSettingsVersion,
        next: { kind: 'v2', content: mutation.settingsMutation.content, remoteAlertPolicy: mutation.settingsMutation.remoteAlertPolicy } });
    if (settings.status !== 'success') throw new ConnectedAccountCatalogPairedMutationRejected(settings.status === 'version_mismatch'
        ? { status: 'settings-conflict', revision: settings.currentVersion } : { status: 'invalid-stored-content' });
    return Object.assign(transactionResult(() => ({ ...result.resolveResult(), settingsVersion: settings.version })),
        { status: 'updated' as const, revision: result.revision, settingsVersion: settings.version });
}

/** Paired Settings and row CAS share the Account fence and roll back on either refusal. */
export async function mutateConnectedAccountCatalogRow(input: MutationInput): Promise<ConnectedAccountCatalogRowMutationResponseV1> {
    // The Account fence serializes mode, Settings and catalog admission. Shared
    // Secret grants may be changed by other Accounts and still need SSI.
    try { return await inTx(tx => mutateConnectedAccountCatalogRowInTx(tx, input), {
        ...((input.referencedSavedSecretIds?.length ?? 0) > 0 ? { isolationLevel: "Serializable" as const } : {}),
        transactionClass: "connected-account-catalog-mutate",
    }); }
    catch (error) { if (error instanceof ConnectedAccountCatalogPairedMutationRejected) return error.result; throw error; }
}
