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
  it('retains only the actual admitted principals and independent public-link fact', async () => {
    const audience = await readDocAudience({ current: { ...owner, publicAudience: 'retained' },
      readGrants: async () => roster([personGrant, teamGrant]),
    });
    expect(audience).toMatchObject({ shared: true, team: 'Payments team',
      grants: [personGrant, teamGrant], publicLink: true });
  });

  it('does not disclose a foreign roster when a public link already proves sharing', async () => {
    const audience = await readDocAudience({ current: { ...owner, publicAudience: 'retained' },
      readGrants: async () => ({ ...roster([teamGrant]), artifactId: 'another-doc' }),
    });
    expect(audience).toMatchObject({ shared: true, team: null, grants: null, publicLink: true });
  });

  it('does not invent a public-link or recipient list for a reader without roster access', async () => {
    const audience = await readDocAudience({ current: { ...owner, access: 'view', publicAudience: 'unknown' },
      readGrants: async () => { throw new Error('forbidden'); },
    });
    expect(audience).toMatchObject({ shared: true, team: null, grants: null, publicLink: null });
  });

  it('names the Team a document is shared with', async () => {
    await expect(
      readDocAudience({
        current: owner,
        readGrants: async () => roster([personGrant, teamGrant]),
      }),
    ).resolves.toMatchObject({ shared: true, team: 'Payments team' });
  });

  it('says shared without a Team when only people have it', async () => {
    await expect(
      readDocAudience({
        current: owner,
        readGrants: async () => roster([personGrant]),
      }),
    ).resolves.toMatchObject({ shared: true, team: null });
  });

  it('says only you when nobody else has it', async () => {
    await expect(
      readDocAudience({ current: owner, readGrants: async () => roster([]) }),
    ).resolves.toMatchObject({ shared: false, team: null });
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
    ).resolves.toMatchObject({ shared: true, team: null });
  });
});
