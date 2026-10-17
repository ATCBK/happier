import {
    publishActivePluginAccountHostedArtifact,
    type ActivePluginAccountHostedArtifactPublishResult,
} from '@/sync/api/plugins/availability/activePluginAccountHostedArtifactRead';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

import type { PluginSelectedArtifactLease } from './artifactLease';
import type { PluginAccountAvailabilityReader } from './reader';

export type PluginAccountHostedArtifactPublicationResult = ActivePluginAccountHostedArtifactPublishResult;

export type PluginAccountHostedArtifactPublication = Readonly<{
    completion: Promise<PluginAccountHostedArtifactPublicationResult>;
}>;

export type PluginAccountHostedArtifactPublicationInput = Readonly<{
    /** Availability owns hosting admission; this function never re-derives it. */
    reader: Pick<PluginAccountAvailabilityReader, 'readCurrentHostedPublicationTarget'>;
    accountLifetime: ActiveServerAccountScopeLifetime;
    /** An already fully verified lease; its declared bytes are the only payload. */
    lease: PluginSelectedArtifactLease;
    signal?: AbortSignal;
}>;

/**
 * The one place a verified Artifact lease becomes an Account-hosted archive.
 *
 * Account hosting exists so a new uncached client can cold-load a plugin
 * surface with every daemon offline. Nothing else in the product uploads the
 * archive, so the present client that has just verified those exact bytes is
 * the only producer that ever holds them beside a current Account authority.
 *
 * It owns no queue, retry, receipt, or byte store: publication is one
 * invocation of the existing qualified publication Action, gated by
 * Availability's existing hosting admission, and its failure is a truthful
 * result that leaves the verified lease untouched. Archive/slot/digest
 * exactness stays with that Action, which recomputes the digest from these
 * bytes rather than trusting a coordinate compared here.
 */
export async function publishVerifiedPluginArtifactToAccountHosting(
    input: PluginAccountHostedArtifactPublicationInput,
): Promise<PluginAccountHostedArtifactPublication | null> {
    const current = () => !input.signal?.aborted && input.accountLifetime.isCurrent() && input.lease.isCurrent();
    if (!current()) return null;

    const artifact = input.lease.artifact;
    const admission = input.reader.readCurrentHostedPublicationTarget({
        pluginId: artifact.pluginId,
        contributionId: artifact.contributionId,
        tier: artifact.tier,
        platform: artifact.platform,
    });
    if (admission.kind !== 'available') return null;
    const target = admission.target;

    const files: Array<Readonly<{ relativePath: string; bytes: Uint8Array }>> = [];
    for (const declared of input.lease.files) {
        if (!current()) return null;
        const read = await input.lease.readFile(declared.relativePath);
        if (!current() || read.kind !== 'available') return null;
        files.push(Object.freeze({
            relativePath: read.file.relativePath,
            // readFile already detached these verified bytes. This snapshot
            // stays in publisher custody even if the renderer disposes its lease.
            bytes: read.bytes,
        }));
    }
    if (!current()) return null;

    const completion = publishActivePluginAccountHostedArtifact({
        accountLifetime: input.accountLifetime,
        release: target.release,
        slot: target.slot,
        artifactGraph: input.lease.artifactGraph,
        files: Object.freeze(files),
        ...(input.signal ? { signal: input.signal } : {}),
    }).catch((): PluginAccountHostedArtifactPublicationResult => Object.freeze({
        kind: 'unavailable',
        code: 'transport_unavailable',
    }));
    // Only verified-file capture blocks acquisition. Network completion is a
    // separate status; the existing publisher owns cancellation and Account E2EE.
    return Object.freeze({ completion });
}
