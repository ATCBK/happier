import type { AcpBackendLaunchV1 } from '../settingsV1.js';
import { z } from 'zod';
import { PinnedArchivePlatformSchema } from '../../../installables/sourceKind.js';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import type { AcpRegistryAgentV1 } from '../../../registries/registryItemsV1.js';
import { mapAcpRegistryBinaryAssetsV1, selectAcpRegistryDistributionV1 } from './mapAcpRegistryAgentV1.js';
type PinnedArchiveAssetsByPlatform = Extract<AcpBackendLaunchV1, { kind: 'archive' }>['assetsByPlatform'];

export type AcpPlatformFitV1 =
  | Readonly<{ kind: 'can_run'; via: AcpBackendLaunchV1['kind']; target?: keyof PinnedArchiveAssetsByPlatform }>
  | Readonly<{ kind: 'cant_run'; reason: 'no_build_for_platform' | 'archive_type_unsupported' | 'managed_uv_unavailable' }>
  | Readonly<{ kind: 'unknown'; reason: 'platform_unknown' | 'arch_unknown' }>;

export const AcpPlatformFitV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('can_run'), via: z.enum(['command', 'npm', 'archive', 'uv']), target: PinnedArchivePlatformSchema.optional() }).strict(),
  z.object({ kind: z.literal('cant_run'), reason: z.enum(['no_build_for_platform', 'archive_type_unsupported', 'managed_uv_unavailable']) }).strict(),
  z.object({ kind: z.literal('unknown'), reason: z.enum(['platform_unknown', 'arch_unknown']) }).strict(),
]));

export function resolveAcpPlatformFitV1(input: AcpBackendLaunchV1 | AcpRegistryAgentV1['distributions'],
  machine: Readonly<{ platform: string | null; arch: string | null }>,
): AcpPlatformFitV1 {
  if (!machine.platform) return { kind: 'unknown', reason: 'platform_unknown' };
  if (!machine.arch) return { kind: 'unknown', reason: 'arch_unknown' };
  const distribution = 'kind' in input ? null : selectAcpRegistryDistributionV1(input);
  if (!('kind' in input) && !distribution) return { kind: 'cant_run', reason: 'no_build_for_platform' };
  const kind = 'kind' in input ? input.kind : distribution!.kind;
  const platform = machine.platform === 'windows' ? 'win32' : machine.platform === 'macos' ? 'darwin' : machine.platform;
  const arch = machine.arch === 'aarch64' ? 'arm64' : machine.arch === 'x86_64' ? 'x64' : machine.arch;
  if (!['darwin', 'linux', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch)) return { kind: 'cant_run', reason: 'no_build_for_platform' };
  if (kind === 'uv') return { kind: 'cant_run', reason: 'managed_uv_unavailable' };
  if (kind !== 'archive') return { kind: 'can_run', via: kind };
  const target = `${platform}-${arch}` as keyof PinnedArchiveAssetsByPlatform;
  const mapped = distribution?.kind === 'archive' ? mapAcpRegistryBinaryAssetsV1(distribution.distribution) : null;
  const assets = 'kind' in input && input.kind === 'archive' ? input.assetsByPlatform : mapped?.success ? mapped.data : {};
  const asset = assets[target];
  if (!asset) return { kind: 'cant_run', reason: 'no_build_for_platform' };
  if (asset.kind !== 'executable' && !/\.(?:zip|tar\.gz|tgz|tar\.xz)$/i.test(new URL(asset.archiveUrl).pathname)) {
    return { kind: 'cant_run', reason: 'archive_type_unsupported' };
  }
  return { kind: 'can_run', via: 'archive', target };
}
