import { describe, expect, it } from 'vitest';

import { PinnedArchiveInstallableAssetSchema } from './sourceKind.js';
import { PluginManagedDependencyContributionV2Schema } from '../plugins/contributions/managedDependencies.js';

describe('pinned archive checksum boundaries', () => {
  it('accepts Account assets without a checksum, including raw executables', () => {
    const asset = { archiveUrl: 'https://example.test/agent', executableSubpath: 'bin/agent', kind: 'executable' };
    expect(PinnedArchiveInstallableAssetSchema.parse(asset)).toEqual(asset);
    expect(PinnedArchiveInstallableAssetSchema.safeParse({ ...asset, sha256: 'invalid' }).success).toBe(false);
  });

  it('requires a checksum for every manifest-declared platform asset', () => {
    const asset = { archiveUrl: 'https://example.test/agent.zip', executableSubpath: 'agent' };
    const dependency = {
      id: 'agent', title: 'Agent', executable: 'agent',
      sources: [{ kind: 'pinnedArchive', installId: 'dep.agent', version: '1', assetsByPlatform: {
        'linux-x64': { ...asset, sha256: 'a'.repeat(64) }, 'darwin-arm64': asset,
      } }],
    };
    expect(PluginManagedDependencyContributionV2Schema.safeParse(dependency).success).toBe(false);
  });
});
