import type { ArtifactAccessGrantsListResponseV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import {
  readArtifactSharedAudienceV1,
  type ArtifactSharingResourceV1,
} from '@happier-dev/protocol/artifacts/artifactSharingV1';

/** Who a Doc reaches, for its header line: shared (naming the Team when one has it) or only the reader. */
export type DocAudience = Readonly<{ shared: boolean; team: string | null }>;

/**
 * The admitted audience (the canonical `readArtifactSharedAudienceV1` decision) plus the Team a grant
 * names, read from the same roster. `null` when it cannot be known: unknown says nothing, never "only you".
 */
export async function readDocAudience(
  params: Readonly<{
    current: ArtifactSharingResourceV1;
    readGrants: () => Promise<ArtifactAccessGrantsListResponseV1>;
  }>,
): Promise<DocAudience | null> {
  let roster: Promise<ArtifactAccessGrantsListResponseV1> | null = null;
  const readGrants = () => (roster ??= params.readGrants());
  const shared = await readArtifactSharedAudienceV1({
    current: params.current,
    readGrants,
  }).catch(() => null);
  if (shared === null) return null;
  if (!shared) return { shared, team: null };
  // A recipient may not see the roster; it is still shared with them.
  const grants = await readGrants().catch(() => null);
  const team =
    grants?.grants.find(
      (grant) => grant.principal.kind === 'team' && grant.display.name,
    )?.display.name ?? null;
  return { shared, team };
}
