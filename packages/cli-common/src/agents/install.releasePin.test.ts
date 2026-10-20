import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchGitHubLatestRelease, fetchGitHubReleaseByTag } from '@happier-dev/release-runtime';
import { describe, expect, it } from 'vitest';

import { installAgentCliForRuntime, resolvePlatformFromNodePlatform } from './install.js';
import type { AgentCliRuntimeDescriptor } from './resolution.js';
import { fetchAgentCliLatestVersion } from './update.js';
import { downloadGitHubReleaseAsset } from './downloadGitHubReleaseAsset.js';

describe('managed GitHub release selection', () => {
  it.each([true, false])('installs and advertises the same release for an external Agent (pinned=%s)', async (pinned) => {
    const home = await mkdtemp(join(tmpdir(), 'happier-agent-release-pin-'));
    const platform = resolvePlatformFromNodePlatform(process.platform);
    if (!platform) throw new Error('Unsupported fixture platform');
    const binaryName = 'fixture-agent';
    const assetName = process.platform === 'win32'
      ? `${binaryName}-windows-${process.arch}.exe`
      : `${binaryName}-${process.platform}-${process.arch}`;
    const bodies = { pinned: Buffer.from('qualified-fixture-binary'), latest: Buffer.from('newer-fixture-binary') };
    const requests: string[] = [];
    let origin = '';
    let pinUnavailable = false;
    let tamperBinary = false;
    const server = createServer((request, response) => {
      const path = request.url ?? '';
      requests.push(path);
      if (pinned && path.startsWith('/repos/')) {
        response.writeHead(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1792364400' });
        response.end();
        return;
      }
      if (pinUnavailable && path.includes('/expanded_assets/')) {
        response.writeHead(503);
        response.end();
        return;
      }
      if (path.startsWith('/assets/') || path.includes('/releases/download/')) {
        const body = path === '/assets/pinned' || path.includes('/releases/download/') ? bodies.pinned : bodies.latest;
        response.end(tamperBinary ? Buffer.from('tampered-binary') : body);
        return;
      }
      if (path.includes('/expanded_assets/')) {
        response.end(`<ul><li><a href="/acme/fixture-agent/releases/download/qualified-v1.2.3/${assetName}">${assetName}</a>
          <clipboard-copy value="sha256:${createHash('sha256').update(bodies.pinned).digest('hex')}"></clipboard-copy></li></ul>`);
        return;
      }
      const selected = path.endsWith('/tags/qualified-v1.2.3') ? 'pinned' : 'latest';
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        tag_name: selected === 'pinned' ? 'qualified-v1.2.3' : 'v1.2.4',
        assets: [{
          name: assetName,
          browser_download_url: `${origin}/assets/${selected}`,
          digest: `sha256:${createHash('sha256').update(bodies[selected]).digest('hex')}`,
        }],
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture address');
      origin = `http://127.0.0.1:${address.port}`;
      // Redirect only the external GitHub HTTP boundary; keep its release readers,
      // digest verification, asset download, installer and update owner real.
      const fetchImpl: typeof fetch = (url, init) => fetch(`${origin}${new URL(String(url)).pathname}`, init);
      const deps = {
        fetchGitHubLatestRelease: (params: Parameters<typeof fetchGitHubLatestRelease>[0]) => fetchGitHubLatestRelease({ ...params, fetchImpl }),
        fetchGitHubReleaseByTag: (params: Parameters<typeof fetchGitHubReleaseByTag>[0]) => fetchGitHubReleaseByTag({ ...params, fetchImpl }),
        // Route only the asset HTTP boundary to the loopback publisher; real
        // download hashing, promotion and installer lifecycle remain in use.
        downloadGitHubReleaseAsset: (params: Parameters<typeof downloadGitHubReleaseAsset>[0]) => downloadGitHubReleaseAsset({
          ...params, url: `${origin}${new URL(params.url).pathname}`,
        }),
      };
      const runtimeSpec: AgentCliRuntimeDescriptor = {
        id: 'acme-external-fixture-agent', title: 'External Agent', binaryName,
        sourcePreferenceDefault: 'managed-first', acceptsJavaScriptFileOverride: false,
        manualInstallKind: 'none', manualInstallRecipes: null,
        managedInstall: {
          kind: 'github_release_binary', githubRepo: 'acme/fixture-agent', binaryName,
          ...(pinned ? { releaseTag: 'qualified-v1.2.3' } : {}),
        },
      };
      const result = await installAgentCliForRuntime({
        runtimeSpec, platform, logDir: join(home, 'logs'), skipIfInstalled: false,
        env: { HAPPIER_HOME_DIR: home, PATH: '' }, deps,
      });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      const installed = join(home, 'tools', 'providers', runtimeSpec.id, 'current', 'bin',
        process.platform === 'win32' ? `${binaryName}.exe` : binaryName);
      await expect(readFile(installed)).resolves.toEqual(pinned ? bodies.pinned : bodies.latest);
      await expect(fetchAgentCliLatestVersion({ runtimeSpec, installSource: 'managed', deps }))
        .resolves.toEqual({ latestVersion: pinned ? '1.2.3' : '1.2.4', heldVersion: null });
      expect(requests).toEqual(pinned ? [
        '/acme/fixture-agent/releases/expanded_assets/qualified-v1.2.3',
        `/acme/fixture-agent/releases/download/qualified-v1.2.3/${assetName}`,
      ] : [
        '/repos/acme/fixture-agent/releases/latest', '/assets/latest',
        '/repos/acme/fixture-agent/releases/latest',
      ]);
      if (pinned) {
        tamperBinary = true;
        const corruptUpdate = await installAgentCliForRuntime({
          runtimeSpec, platform, logDir: join(home, 'logs'), intent: 'update',
          env: { HAPPIER_HOME_DIR: home, PATH: '' }, deps,
        });
        expect(corruptUpdate).toMatchObject({ ok: false, errorCode: 'verification-failed' });
        await expect(readFile(installed)).resolves.toEqual(bodies.pinned);
        tamperBinary = false;
        const beforeUnavailable = requests.length;
        pinUnavailable = true;
        const failedUpdate = await installAgentCliForRuntime({
          runtimeSpec, platform, logDir: join(home, 'logs'), intent: 'update',
          env: { HAPPIER_HOME_DIR: home, PATH: '' }, deps,
        });
        expect(failedUpdate).toMatchObject({ ok: false, errorCode: 'download-failed' });
        await expect(readFile(installed)).resolves.toEqual(bodies.pinned);
        await expect(fetchAgentCliLatestVersion({ runtimeSpec, installSource: 'managed', deps }))
          .resolves.toEqual({ latestVersion: '1.2.3', heldVersion: null });
        expect(requests.slice(beforeUnavailable)).toEqual(['/acme/fixture-agent/releases/expanded_assets/qualified-v1.2.3']);
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  });
});
