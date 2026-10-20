import { buildSessionFollowRulePhysicalKeyV1, parseSessionFollowRulePhysicalKeyV1, SESSION_FOLLOW_RULE_ACCOUNT_PREFIX_V1,
    equalFollowRuleReceiverV1, type AccountEncryptionMigrateSessionFollowRulesDirectiveV1,
    type SessionFollowRuleStoredRowV1, type SessionFollowRuleV1,
} from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import { migrateReservedAccountScopedKvRowsForAccountModeInTx, matchReservedAccountScopedKvRowsAccountMigrationPostStateInTx,
    type ReservedAccountScopedKvRowMigrationItem } from '@/app/kv/reservedAccountScopedKvRow';
import type { Tx } from '@/storage/inTx';
import { accountFollowRuleRowDomain, listAccountFollowRuleRowsInTx, markAccountFollowRulesChangedInTx } from './accountFollowRuleService';

type Params = Readonly<{ accountId: string; toMode: 'plain' | 'e2ee'; directive?: AccountEncryptionMigrateSessionFollowRulesDirectiveV1 }>;

async function migrationParams(tx: Tx, input: Params, replay: boolean) {
    const source = await listAccountFollowRuleRowsInTx(tx, input);
    if (source.status !== 'listed' || !source.complete || source.nextCursor !== null) return null;
    const active = source.rows.filter(row => row.envelope !== null);
    const candidates = input.directive?.items ?? [];
    const byId = new Map(candidates.map(item => [item.ruleId, item]));
    if (byId.size !== candidates.length || byId.size !== active.length) return null;
    const items: ReservedAccountScopedKvRowMigrationItem<SessionFollowRuleStoredRowV1>[] = [];
    for (const row of source.rows) {
        const ruleId = parseSessionFollowRulePhysicalKeyV1(row.physicalKey);
        if (ruleId === null) return null;
        if (row.envelope === null) continue;
        const item = byId.get(ruleId);
        if (!item || row.envelope.version !== item.expectedVersion + (replay ? 1 : 0)
            || !equalFollowRuleReceiverV1(item.receiver, row.envelope.receiver)) return null;
        // Replay proves the requested authoring content/receiver/version, not historical physical bytes.
        // Progress may legitimately advance the physical CAS after conversion. Preserve that current
        // progress and project the same public result; never rewind it to the migration's old snapshot.
        // The Account request-binding owner authorizes replay; the shared helper checks current content.
        items.push({ physicalKey: buildSessionFollowRulePhysicalKeyV1(ruleId), revision: row.revision - (replay ? 1 : 0),
            envelope: { ...row.envelope, version: item.expectedVersion + 1, receiver: item.receiver, content: item.content } });
    }
    return { accountId: input.accountId, toMode: input.toMode, physicalPrefix: SESSION_FOLLOW_RULE_ACCOUNT_PREFIX_V1,
        domain: accountFollowRuleRowDomain, isPhysicalKey: (key: string) => parseSessionFollowRulePhysicalKeyV1(key) !== null, items };
}
function projectRules(rows: readonly ReservedAccountScopedKvRowMigrationItem<SessionFollowRuleStoredRowV1>[]): SessionFollowRuleV1[] {
    return rows.map(row => {
        const ruleId = parseSessionFollowRulePhysicalKeyV1(row.physicalKey);
        if (ruleId === null) throw new Error('Invalid private Follow rule migration address');
        return { ruleId, version: row.envelope.version, receiver: row.envelope.receiver, content: row.envelope.content,
            ...(row.envelope.inception ? { inception: row.envelope.inception } : {}),
            ...(row.envelope.sources ? { sources: row.envelope.sources } : {}) };
    });
}
/** Participates only inside the incumbent Account fence and all-domain conversion transaction. */
export async function migrateAccountFollowRulesForAccountModeInTx(tx: Tx, input: Params) {
    const params = await migrationParams(tx, input, false);
    if (!params) return { status: 'migration_incomplete' as const };
    const result = await migrateReservedAccountScopedKvRowsForAccountModeInTx(tx, { ...params,
        markChanged: ({ tx: changeTx }) => markAccountFollowRulesChangedInTx(changeTx, input) });
    return result.status === 'applied' ? { status: 'applied' as const, rules: projectRules(result.rows) } : result;
}
/** The existing request digest/replay owner authorizes this read-only exact-definition check. */
export async function matchAccountFollowRulesAccountMigrationPostStateInTx(tx: Tx, input: Params) {
    const params = await migrationParams(tx, input, true);
    if (!params) return { status: 'mismatch' as const };
    const result = await matchReservedAccountScopedKvRowsAccountMigrationPostStateInTx(tx, params);
    return result.status === 'matched' ? { status: 'matched' as const, rules: projectRules(result.rows) } : result;
}
