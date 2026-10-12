import { describe, expect, it } from 'vitest';
import { resolveAcpPlatformFitV1 } from './acpPlatformFitV1.js';
import type { AcpBackendLaunchV1 } from '../settingsV1.js';

describe('resolveAcpPlatformFitV1', () => {
  const archive: AcpBackendLaunchV1 = { kind: 'archive', version: '1', args: [], assetsByPlatform: {
    'linux-x64': { archiveUrl: 'https://example.com/agent.tar.gz', executableSubpath: 'agent' },
  } };
  it('requires observed platform and architecture and an actual archive target', () => {
    expect(resolveAcpPlatformFitV1(archive, { platform: 'linux', arch: null })).toEqual({ kind: 'unknown', reason: 'arch_unknown' });
    expect(resolveAcpPlatformFitV1(archive, { platform: null, arch: 'x64' })).toEqual({ kind: 'unknown', reason: 'platform_unknown' });
    expect(resolveAcpPlatformFitV1(archive, { platform: 'windows', arch: 'aarch64' })).toEqual({ kind: 'cant_run', reason: 'no_build_for_platform' });
    expect(resolveAcpPlatformFitV1(archive, { platform: 'linux', arch: 'x64' })).toEqual({ kind: 'can_run', via: 'archive', target: 'linux-x64' });
  });
  it('rejects unsupported extraction and keeps raw executables runnable', () => {
    const asset = { archiveUrl: 'https://example.com/agent.tar.bz2', executableSubpath: 'agent' };
    expect(resolveAcpPlatformFitV1({ ...archive, assetsByPlatform: { 'linux-x64': asset } }, { platform: 'linux', arch: 'x64' })).toEqual({ kind: 'cant_run', reason: 'archive_type_unsupported' });
    expect(resolveAcpPlatformFitV1({ ...archive, assetsByPlatform: { 'linux-x64': { ...asset, kind: 'executable' } } }, { platform: 'linux', arch: 'x64' })).toMatchObject({ kind: 'can_run' });
  });
  it('reports uv unavailable until the managed uv consumer lands', () => {
    expect(resolveAcpPlatformFitV1({ kind: 'uv', package: 'agent', version: '1', args: [] }, { platform: 'linux', arch: 'x64' })).toEqual({ kind: 'cant_run', reason: 'managed_uv_unavailable' });
  });
});
