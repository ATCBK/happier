import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { expect, it } from 'vitest';

import { createProductBrowserSidecarControlAdapterFactory } from '../browser/sidecar/productSource';
import type { SidecarBrowserBinaryCandidate } from '../browser/sidecar/binary';
import { createAttachedManagedRunFixture } from './startDaemonSessionControlRuntime.accountManagedRun.testkit';

it('serves control during an installed-browser probe, keeps missing routes unavailable, and rejects a late adapter after retirement', async () => {
  let releaseProbe!: (candidate: SidecarBrowserBinaryCandidate | null) => void;
  let probeStarted = false;
  let browserPublished = false;
  const installedBrowser = new Promise<SidecarBrowserBinaryCandidate | null>(resolve => { releaseProbe = resolve; });
  let releaseRetry!: (candidate: SidecarBrowserBinaryCandidate | null) => void;
  const retryBrowser = new Promise<SidecarBrowserBinaryCandidate | null>(resolve => { releaseRetry = resolve; });
  let probes = 0;
  const starter = createAttachedManagedRunFixture({ browserStartup: {
    onBrowserControlRoutesReady: () => { browserPublished = true; },
    resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({
      features: { browser: { enabled: true, viewTargets: { enabled: true }, internal: { enabled: true },
        sidecar: { enabled: true }, automation: { enabled: true } } },
    }) }),
    browserSidecarControlAdapterFactory: createProductBrowserSidecarControlAdapterFactory({
      featureEnabled: true,
      autoInstallWhenMissing: false,
      // Installed-artifact discovery is the filesystem boundary. Keep the real
      // product source, feature gate, route owner and startup composition.
      resolveManagedCandidate: async () => { probeStarted = true; return await (++probes === 1 ? installedBrowser : retryBrowser); },
    }),
  } });
  let ready = false;
  void starter.then(() => { ready = true; }, () => {});
  try {
    await expect.poll(() => probeStarted, { timeout: 10_000 }).toBe(true);
    await expect.poll(() => ready, { timeout: 10_000 }).toBe(true);
    const fixture = await starter;
    expect(fixture.control?.agentRuntimeDaemonServices).toBeDefined();
    expect(browserPublished).toBe(false);
    expect(fixture.runtime.guardSources.readBrowsers()).toEqual([]);
    const initialRefresh = fixture.runtime.refreshBrowserRouteOwners();
    releaseProbe({ source: 'managedBrowserPackage', discoveryKind: 'managedRuntime', available: false });
    await initialRefresh;
    expect(browserPublished).toBe(false);
    expect(fixture.runtime.guardSources.readBrowsers()).toEqual([]);
    const refresh = fixture.runtime.refreshBrowserRouteOwners();
    await expect.poll(() => probes, { timeout: 10_000 }).toBe(2);
    await fixture.runtime.stopControlServer();
    releaseRetry({ source: 'managedBrowserPackage', discoveryKind: 'managedRuntime', available: true,
      executablePath: process.execPath, provenance: { origin: 'managed_package', pinnedVersion: '127.0.6533.88',
        channel: 'stable', integrityDigest: `sha256:${'a'.repeat(64)}`, license: 'BSD-3-Clause' } });
    await refresh;
    expect(browserPublished).toBe(false);
    expect(fixture.runtime.guardSources.readBrowsers()).toEqual([]);
  } finally {
    releaseProbe(null);
    releaseRetry(null);
    await (await starter).cleanup();
  }
});
