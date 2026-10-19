import { describe, expect, it } from 'vitest';
import type { ArtifactAccessGrantsListResponseV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';

import { readDocAudience } from './docAudience';

const owner = {
  artifactId: 'doc-1',
  header: {},
  ownerAccountId: 'me',
  access: 'owner' as const,
  publicAudience: 'none' as const,
};
function roster(
  grants: ArtifactAccessGrantsListResponseV1['grants'],
  access: ArtifactAccessGrantsListResponseV1['access'] = 'owner',
): ArtifactAccessGrantsListResponseV1 {
  return { artifactId: 'doc-1', ownerAccountId: 'me', access, grants };
}
const teamGrant = {
  principal: { kind: 'team' as const, teamId: 'payments' },
  accessLevel: 'edit' as const,
  createdByAccountId: 'me',
  createdAt: 1,
  display: { name: 'Payments team' },
};
const personGrant = {
  principal: { kind: 'account' as const, accountId: 'ana' },
  accessLevel: 'view' as const,
  createdByAccountId: 'me',
  createdAt: 1,
  display: { name: 'Ana' },
};

describe('readDocAudience', () => {
  it('names the Team a document is shared with', async () => {
    await expect(
      readDocAudience({
        current: owner,
        readGrants: async () => roster([personGrant, teamGrant]),
      }),
    ).resolves.toEqual({ shared: true, team: 'Payments team' });
  });

  it('says shared without a Team when only people have it', async () => {
    await expect(
      readDocAudience({
        current: owner,
        readGrants: async () => roster([personGrant]),
      }),
    ).resolves.toEqual({ shared: true, team: null });
  });

  it('says only you when nobody else has it', async () => {
    await expect(
      readDocAudience({ current: owner, readGrants: async () => roster([]) }),
    ).resolves.toEqual({ shared: false, team: null });
  });

  it('is unknown, never private, when the roster cannot be read', async () => {
    await expect(
      readDocAudience({
        current: owner,
        readGrants: async () => {
          throw new Error('offline');
        },
      }),
    ).resolves.toBeNull();
  });

  it('a recipient sees it as shared even when the roster is closed to them', async () => {
    await expect(
      readDocAudience({
        current: { ...owner, ownerAccountId: 'ana', access: 'view' },
        readGrants: async () => {
          throw new Error('artifact_access_forbidden');
        },
      }),
    ).resolves.toEqual({ shared: true, team: null });
  });
});
