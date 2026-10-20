import { InstallableDependencyDescriptorSchema } from '../descriptor.js';
import type { PinnedArchiveInstallableAsset } from '../sourceKind.js';

export const COMPUTER_CUA_DRIVER_INSTALLABLE_KEY = 'computer-cua-driver';
export const COMPUTER_CUA_DRIVER_DEP_ID = 'dep.computer-cua-driver';
export const COMPUTER_CUA_DRIVER_VERSION = '0.37.0';

// MIT native core, cua-driver-rs-v0.37.0 (2d2f99228d4d2508dc6fcc84c176b296e146714a).
// Companion libraries are retained; optional perception models are not installed.
function asset(name: string, sha256: string, executableSubpath = 'cua-driver'): PinnedArchiveInstallableAsset {
  return {
    archiveUrl: `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${COMPUTER_CUA_DRIVER_VERSION}/cua-driver-rs-${COMPUTER_CUA_DRIVER_VERSION}-${name}`,
    sha256,
    executableSubpath,
  };
}

const mac = asset('darwin-universal-binary.tar.gz', '7d491f67f54be5f3b380ffd85c64b242eaefd05dad6df78012cde227c95aee2a');
export const COMPUTER_CUA_DRIVER_INSTALLABLE_DESCRIPTOR = InstallableDependencyDescriptorSchema.parse({
  id: COMPUTER_CUA_DRIVER_INSTALLABLE_KEY,
  key: COMPUTER_CUA_DRIVER_INSTALLABLE_KEY,
  kind: 'dep', version: '1', capabilityId: COMPUTER_CUA_DRIVER_DEP_ID,
  display: { name: 'Native computer driver' },
  description: 'Pinned native screen capture and computer input driver.',
  source: { kind: 'pinned_archive', version: COMPUTER_CUA_DRIVER_VERSION, assetsByPlatform: {
    'darwin-x64': mac, 'darwin-arm64': mac,
    'linux-x64': asset('linux-x86_64-binary.tar.gz', 'c7ac376b10da7c207e510b2d90b88a9588bec9852a237962c273fe81b9cd5623'),
    'linux-arm64': asset('linux-arm64-binary.tar.gz', '879e8040a4ce24caeee34b2e4ac6119be01661082202919db1bcc1ab0b97e4c8'),
    'win32-x64': asset('windows-x86_64-binary.zip', '40481b55073f1225b0010235b30217bd640ef1f323e982aec0a5f6131d3e4a99', 'cua-driver.exe'),
    'win32-arm64': asset('windows-arm64-binary.zip', '0fce682b251775e25fd76bf29ff856f7f5ab5aae5759d6b76a40f8312a194a5a', 'cua-driver.exe'),
  } },
  binary: { commands: ['cua-driver'], systemFirst: false, managedFallback: true },
  defaultPolicy: { autoInstallWhenNeeded: false, autoUpdateMode: 'off' },
  consent: { install: 'required', update: 'required' },
});
