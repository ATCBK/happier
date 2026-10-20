import type { AcpBackendLaunchV1 } from '@happier-dev/protocol/acp/catalog/settingsV1';

type ArchiveAssets = Extract<AcpBackendLaunchV1, { kind: 'archive' }>['assetsByPlatform'];
type ArchiveTarget = keyof ArchiveAssets;

/** Summarize the builds machines can download, or every published build when none is selected. */
export function areAgentRegistryChecksumsPublished(
  assetsByPlatform: Readonly<Partial<Record<ArchiveTarget, Readonly<{ sha256?: string }>>>>,
  runnableTargets: readonly ArchiveTarget[] = [],
): boolean {
  const assets = runnableTargets.length > 0
    ? runnableTargets.map((target) => assetsByPlatform[target])
    : Object.values(assetsByPlatform);
  return assets.length > 0 && assets.every((asset) => Boolean(asset?.sha256));
}
