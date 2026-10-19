import { deriveArtifactCoarseKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { supportsArtifactKindFiltering, updateArtifact, type ArtifactApiOptions } from '@/sync/api/artifacts/apiArtifacts';

/** Opportunistic metadata repair from headers this inventory read has already opened. */
export async function backfillArtifactKinds(params: Readonly<{
    credentials: AuthCredentials;
    artifacts: readonly DecryptedArtifact[];
    serverId?: string;
    request?: ArtifactApiOptions['request'];
    signal?: AbortSignal;
    shouldContinue: () => boolean;
}>): Promise<void> {
    try {
        if (!params.shouldContinue() || !await supportsArtifactKindFiltering(params)) return;
        for (const artifact of params.artifacts) {
            if (!params.shouldContinue() || params.signal?.aborted) return;
            if (artifact.kind != null || artifact.access === undefined || artifact.access === 'view' || !artifact.isDecrypted
                || !artifact.rawHeader || Object.keys(artifact.rawHeader).length === 0) continue;
            try {
                await updateArtifact(params.credentials, artifact.id, {
                    kind: deriveArtifactCoarseKindV1(artifact.rawHeader), expectedHeaderVersion: artifact.headerVersion,
                }, { request: params.request, serverId: params.serverId, signal: params.signal, retry: 'none' });
            } catch {
                // Refusal of one stale/read-only header does not prevent independent rows being classified.
            }
        }
    } catch {
        // A failed/retired observation leaves rows unclassified for a future ordinary inventory read.
    }
}
