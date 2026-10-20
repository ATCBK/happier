import type { ArtifactAccessGrantsListResponseV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { readArtifactSharedAudienceV1, type ArtifactSharingResourceV1 } from '@happier-dev/protocol/artifacts/artifactSharingV1';

/** Admitted audience details; an unavailable roster is unknown, never an empty audience. */
export type ArtifactAudience = Readonly<{
  shared: boolean;
  team: string | null;
  grants: ArtifactAccessGrantsListResponseV1['grants'] | null;
  publicLink: boolean | null;
}>;

/** One read/projection for Doc and Memory headers, independent of attachment or Project placement. */
export async function readArtifactAudience(params: Readonly<{
  current: ArtifactSharingResourceV1;
  readGrants: () => Promise<ArtifactAccessGrantsListResponseV1>;
  signal?: AbortSignal;
}>): Promise<ArtifactAudience | null> {
  let roster: Promise<ArtifactAccessGrantsListResponseV1> | null = null;
  const readGrants = () => (roster ??= params.readGrants().then(value => {
    params.signal?.throwIfAborted();
    if (value.artifactId !== params.current.artifactId
      || params.current.ownerAccountId !== undefined && value.ownerAccountId !== params.current.ownerAccountId) {
      throw new Error('artifact_audience_mismatch');
    }
    return value;
  }));
  const shared = await readArtifactSharedAudienceV1({ ...params, readGrants }).catch(() => null);
  if (shared === null) return null;
  // A recipient or public reader can know it is shared without authority to enumerate its grants.
  const grants = (await readGrants().catch(() => null))?.grants ?? null;
  params.signal?.throwIfAborted();
  return { shared, grants,
    team: grants?.find(grant => grant.principal.kind === 'team' && grant.display.name)?.display.name ?? null,
    publicLink: params.current.publicAudience === 'retained' ? true : params.current.publicAudience === 'none' ? false : null,
  };
}
