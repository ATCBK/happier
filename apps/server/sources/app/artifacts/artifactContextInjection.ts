import type { Tx } from '@/storage/inTx';
import { isPublicSessionShareActive } from '@/app/share/publicSessionSharePublication';
import type { ResourceContextStorageAdapter } from '@/app/session/access/sessionContextInjection';
import { resolveResourceGrantAccessInTx, resolveResourceGrantAccessFromFacts, type ResourceGrantAccessFacts } from '@/app/teams/resourceGrantAccess';
import { artifactGrantStorageAdapter } from './artifactGrantStorageAdapter';

/**
 * The existing Artifact HTTP/socket or signed Action-effect boundary admits the credential.
 * This adapter supplies that admitted writer's grants, never independent credential authority.
 */
export const artifactContextStorageAdapter: ResourceContextStorageAdapter = {
    ...artifactGrantStorageAdapter,
    resolveConfigurerAccessInTx(tx, input) {
        return resolveResourceGrantAccessInTx(tx, artifactGrantStorageAdapter, input);
    },
    async hasPublicAudienceInTx(tx, artifactId) {
        const publication = await tx.publicSessionShare.findUnique({ where: { artifactId }, select: { expiresAt: true } });
        return isPublicSessionShareActive(publication);
    },
};

/** A new Artifact has exactly its transaction-admitted owner, before any grant exists. */
export function newArtifactContextStorageAdapter(input: Readonly<{
    artifactId: string; ownerAccountId: string; encryptionMode: 'plain' | 'e2ee';
}>): ResourceContextStorageAdapter {
    const facts: ResourceGrantAccessFacts = { ownerAccountId: input.ownerAccountId, encryptionMode: input.encryptionMode,
        accountGrants: [], teamGrants: [], groupGrants: [] };
    return {
        async readAccessFactsInTx(_tx: Tx, artifactId: string) {
            return artifactId === input.artifactId ? facts : null;
        },
        async resolveConfigurerAccessInTx(_tx, request) {
            return request.resourceId === input.artifactId ? resolveResourceGrantAccessFromFacts(facts, request.actorAccountId) : null;
        },
    };
}
