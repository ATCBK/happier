import { InstallableDependencyDescriptorSchema } from '../descriptor.js';
import type { PinnedArchiveInstallableAsset } from '../sourceKind.js';

export const COMPUTER_CUA_DRIVER_INSTALLABLE_KEY = 'computer-cua-driver';
export const COMPUTER_CUA_DRIVER_DEP_ID = 'dep.computer-cua-driver';
export const COMPUTER_CUA_DRIVER_VERSION = '0.31.0';

// MIT native core, cua-driver-rs-v0.31.0 (5272e492d61b96caf08e3bf434d91126c1f3dccc).
// Companion libraries are retained; optional perception models are not installed.
function asset(name: string, sha256: string, executableSubpath = 'cua-driver'): PinnedArchiveInstallableAsset {
  return {
    archiveUrl: `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${COMPUTER_CUA_DRIVER_VERSION}/cua-driver-rs-${COMPUTER_CUA_DRIVER_VERSION}-${name}`,
    sha256,
    executableSubpath,
  };
}

const mac = asset('darwin-universal-binary.tar.gz', '06cd80b153bdf046dc067fb593e0fc648e780afa37a902ca0515ac25f32f9a4f');
export const COMPUTER_CUA_DRIVER_INSTALLABLE_DESCRIPTOR = InstallableDependencyDescriptorSchema.parse({
  id: COMPUTER_CUA_DRIVER_INSTALLABLE_KEY,
  key: COMPUTER_CUA_DRIVER_INSTALLABLE_KEY,
  kind: 'dep', version: '1', capabilityId: COMPUTER_CUA_DRIVER_DEP_ID,
  display: { name: 'Native computer driver' },
  description: 'Pinned native screen capture and computer input driver.',
  source: { kind: 'pinned_archive', version: COMPUTER_CUA_DRIVER_VERSION, assetsByPlatform: {
    'darwin-x64': mac, 'darwin-arm64': mac,
    'linux-x64': asset('linux-x86_64-binary.tar.gz', '59d7d027ad0f24410e88e0cf239a04f8e724de400b5c418fab259f3b5c285ff1'),
    'linux-arm64': asset('linux-arm64-binary.tar.gz', 'a960ffe07869846dde1e2a193c7c3236d530f31631b035c637b7dd701dd6dc6f'),
    'win32-x64': asset('windows-x86_64-binary.zip', '461c7d4acd12685ab777fa4a3800e25f75d2f06e8a67ab7a1778701eb25e6728', 'cua-driver.exe'),
    'win32-arm64': asset('windows-arm64-binary.zip', 'a65898dfaee3fe7f78671ed2db0b7dc06a3c297ab856a8b70bf7a8c69bf59b95', 'cua-driver.exe'),
  } },
  binary: { commands: ['cua-driver'], systemFirst: false, managedFallback: true },
  defaultPolicy: { autoInstallWhenNeeded: false, autoUpdateMode: 'off' },
  consent: { install: 'required', update: 'required' },
});
