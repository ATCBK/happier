import type { Tx } from '@/storage/inTx';
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from '@/app/encryption/accountEncryptionMode';
import { resourceGrantRelationsSelect, type ResourceGrantAccessFacts, type ResourceGrantStorageAdapter } from '@/app/teams/resourceGrantAccess';
import { artifactVisibleWhere } from './artifactClassification';

export function artifactAccessFactsSelect(actorAccountId?: string) {
    return {
        accountId: true, account: { select: { encryptionMode: true } },
        ...resourceGrantRelationsSelect(actorAccountId),
    } as const;
}

async function readArtifactAccessFactsInTx(tx: Tx, artifactId: string, actorAccountId?: string) {
    return tx.artifact.findFirst({ where: { id: artifactId, ...artifactVisibleWhere }, select: artifactAccessFactsSelect(actorAccountId) });
}

export type ArtifactAccessFacts = NonNullable<Awaited<ReturnType<typeof readArtifactAccessFactsInTx>>>;

export function artifactGrantFacts(row: ArtifactAccessFacts): ResourceGrantAccessFacts {
    const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(row.account);
    return { ownerAccountId: row.accountId, encryptionMode: mode.status === 'ready' ? mode.mode : null,
        accountGrants: row.accountGrants, teamGrants: row.teamGrants, groupGrants: row.groupGrants };
}

/** Artifact storage only; access policy never loads an Artifact body or content key. */
export const artifactGrantStorageAdapter: ResourceGrantStorageAdapter = {
    async readAccessFactsInTx(tx, artifactId, actorAccountId) {
        const row = await readArtifactAccessFactsInTx(tx, artifactId, actorAccountId);
        return row ? artifactGrantFacts(row) : null;
    },
};
