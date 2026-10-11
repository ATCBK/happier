import { COMPUTER_CUA_DRIVER_INSTALLABLE_DESCRIPTOR, COMPUTER_CUA_DRIVER_INSTALLABLE_KEY, COMPUTER_CUA_DRIVER_VERSION, type InstallableDependencyDescriptor } from '@happier-dev/protocol/installables';
import { createPinnedArchiveRuntimeInstallableAdapter, installPinnedArchive, resolveInstalledPinnedArchiveExecutable, type PinnedArchiveAsset } from './pinnedArchive';
import type { RuntimeInstallableAdapter } from '../registry';
import { ARCHIVE_DOWNLOAD_INSTALLABLE_SOURCE_KIND, type ArchiveDownloadInstallableAdapter } from './browserChromium';

export { COMPUTER_CUA_DRIVER_INSTALLABLE_KEY, COMPUTER_CUA_DRIVER_VERSION };

function resolveAsset(platform: string, arch: string, descriptor = COMPUTER_CUA_DRIVER_INSTALLABLE_DESCRIPTOR): PinnedArchiveAsset | null {
  if (descriptor.source.kind !== 'pinned_archive') return null;
  if ((platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') || (arch !== 'arm64' && arch !== 'x64')) return null;
  return descriptor.source.assetsByPlatform[`${platform}-${arch}`] ?? null;
}

/** The capability and native launch share pins, validation and the retained install destination. */
export function getComputerCuaDriverRuntimeInstallableAdapter(descriptor: InstallableDependencyDescriptor): RuntimeInstallableAdapter {
  const asset = resolveAsset(process.platform, process.arch, descriptor);
  if (!asset || descriptor.source.kind !== 'pinned_archive') throw new Error('Unsupported native computer driver platform');
  return { ...createPinnedArchiveRuntimeInstallableAdapter({
    installId: descriptor.capabilityId, managedInstallId: COMPUTER_CUA_DRIVER_INSTALLABLE_KEY,
    version: descriptor.source.version, asset,
  }), key: descriptor.key };
}

export function getComputerCuaDriverArchiveDownloadInstallableAdapter(): ArchiveDownloadInstallableAdapter {
  return {
    key: COMPUTER_CUA_DRIVER_INSTALLABLE_KEY,
    sourceKind: ARCHIVE_DOWNLOAD_INSTALLABLE_SOURCE_KIND,
    async resolveInstalledExecutable(params = {}) {
      const platform = params.platform ?? process.platform;
      const asset = resolveAsset(platform, params.arch ?? process.arch);
      return asset ? await resolveInstalledPinnedArchiveExecutable({
        installId: COMPUTER_CUA_DRIVER_INSTALLABLE_KEY,
        executableSubpath: asset.executableSubpath,
        version: COMPUTER_CUA_DRIVER_VERSION,
        platform,
      }) : null;
    },
    async installOrUpgrade(params = {}) {
      const platform = params.platform ?? process.platform;
      const asset = resolveAsset(platform, params.arch ?? process.arch);
      if (!asset) return { ok: false, errorMessage: `Unsupported native computer driver platform: ${platform}/${params.arch ?? process.arch}` };
      const result = await installPinnedArchive({ installId: COMPUTER_CUA_DRIVER_INSTALLABLE_KEY, version: COMPUTER_CUA_DRIVER_VERSION, asset, platform });
      return result.ok ? { ok: true, executablePath: result.executablePath, pinnedVersion: result.version, integrityDigest: result.integrityDigest } : result;
    },
  };
}
