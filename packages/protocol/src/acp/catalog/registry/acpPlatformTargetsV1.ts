/** ACP Registry target vocabulary → the existing installables platform vocabulary. */
export const ACP_REGISTRY_PLATFORM_TARGETS_V1 = {
  'darwin-aarch64': 'darwin-arm64', 'darwin-x86_64': 'darwin-x64',
  'linux-aarch64': 'linux-arm64', 'linux-x86_64': 'linux-x64',
  'windows-aarch64': 'win32-arm64', 'windows-x86_64': 'win32-x64',
} as const;

/** Native Machine observations and registry targets meet at this single mapping. */
export function resolveAcpPlatformTargetV1(platform: string, arch: string) {
  const os = platform === 'win32' ? 'windows' : platform === 'macos' ? 'darwin' : platform;
  const processor = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : arch;
  const target = `${os}-${processor}`;
  return Object.entries(ACP_REGISTRY_PLATFORM_TARGETS_V1).find(([key]) => key === target)?.[1] ?? null;
}
