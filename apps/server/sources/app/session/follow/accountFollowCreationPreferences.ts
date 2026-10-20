import {
    DEFAULT_SESSION_FOLLOW_CREATION_POLICIES_V1,
    SESSION_FOLLOW_CREATION_PREFERENCES_ACCOUNT_KEY_V1,
    SessionFollowCreationPoliciesV1Schema,
    type SessionFollowCreationPoliciesV1,
} from '@happier-dev/protocol/sessions/follow/accountFollow';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { decodeAccountScopedKvJson, encodeAccountScopedKvJson } from '@/app/kv/accountScopedKv';
import { applyUserKvMutationsInTx, UserKvMutationConflictError } from '@/app/kv/kvMutate';
import type { Tx } from '@/storage/inTx';

/**
 * Like the four Account columns, these are server-readable operational choices
 * in both Account modes. They contain no private rule/filter or content envelope.
 * The existing Account KV mutation owner retains revision and write custody.
 */
async function readCreationPreferencesRowInTx(tx: Tx, accountId: string) {
    const row = await tx.userKVStore.findUnique({ where: { accountId_key: {
        accountId, key: SESSION_FOLLOW_CREATION_PREFERENCES_ACCOUNT_KEY_V1,
    } }, select: { value: true, version: true } });
    if (!row?.value) return { policies: DEFAULT_SESSION_FOLLOW_CREATION_POLICIES_V1, version: row?.version ?? -1 };
    try {
        return { policies: SessionFollowCreationPoliciesV1Schema.parse(decodeAccountScopedKvJson(row.value)), version: row.version };
    } catch {
        throw Object.assign(new Error('Follow creation preferences are unavailable'), { code: 'follow_preferences_unavailable' });
    }
}

export async function readAccountFollowCreationPreferencesInTx(tx: Tx, accountId: string): Promise<SessionFollowCreationPoliciesV1> {
    return (await readCreationPreferencesRowInTx(tx, accountId)).policies;
}

/** A partial creation-policy edit preserves the other choices and all existing relations. */
export async function updateAccountFollowCreationPreferencesInTx(tx: Tx, input: Readonly<{
    accountId: string; patch: Partial<SessionFollowCreationPoliciesV1>;
}>): Promise<Readonly<{ policies: SessionFollowCreationPoliciesV1; changed: boolean }>> {
    const row = await readCreationPreferencesRowInTx(tx, input.accountId);
    const current = row.policies;
    const policies = SessionFollowCreationPoliciesV1Schema.parse({ ...current, ...input.patch });
    if (pluginJsonValuesEqual(current, policies)) return { policies, changed: false };
    const value = encodeAccountScopedKvJson(policies);
    if (value === null) throw new Error('Follow creation preferences could not be encoded');
    const result = await applyUserKvMutationsInTx(tx, { uid: input.accountId }, [{
        key: SESSION_FOLLOW_CREATION_PREFERENCES_ACCOUNT_KEY_V1, version: row.version, value,
    }]).catch((error: unknown) => {
        if (error instanceof UserKvMutationConflictError) {
            throw Object.assign(new Error('Follow creation preferences changed concurrently', { cause: error }), { code: 'follow_preferences_unavailable' });
        }
        throw error;
    });
    if (!result.success) throw Object.assign(new Error('Follow creation preferences changed concurrently'), { code: 'follow_preferences_unavailable' });
    return { policies, changed: true };
}
