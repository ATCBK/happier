import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it, vi } from 'vitest';
import { MarketplaceIndexSourceSnapshotV1Schema } from '@happier-dev/protocol/marketplace';
import { BUILT_IN_REGISTRY_SOURCES_V1, HAPPIER_PICKS_SOURCE_ID, createRegistryHostV1,
  REGISTRY_ACTION_OUTPUT_SCHEMAS_V1, RegistryFetchRequestV1Schema, RegistryFetchResponseV1Schema,
  type RegistryHttpV1, type RegistryFetchRequestV1 } from '@happier-dev/protocol/registries';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { RpcHandler } from '@/api/rpc/types';
import { registerMachineRegistriesRpcHandlers } from '@/api/machine/rpcHandlers.registries';
import { runScmCommand } from '@/scm/runtime';
import { createRegistryGitProtocolV1 } from './gitProtocol';

it('routes explicit non-GitHub pick reads and pinned files through the existing registered daemon owner without a daemon browse on hub open', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'happier-registry-pick-seam-'));
  const command = async (args: string[]) => {
    const result = await runScmCommand({ bin: 'git', cwd, args });
    if (!result.success) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  const catalogSource = BUILT_IN_REGISTRY_SOURCES_V1.find(source => source.id === HAPPIER_PICKS_SOURCE_ID)!;
  const targetUrl = 'https://git.registry.example/skills';
  try {
    await command(['init']);
    await writeFile(join(cwd, 'SKILL.md'), '---\nname: reviewed\n---\nReviewed content\n');
    await command(['add', 'SKILL.md']);
    await command(['-c', 'user.name=Registry fixture', '-c', 'user.email=registry-fixture@example.invalid', 'commit', '-m', 'reviewed']);
    const commit = await command(['rev-parse', 'HEAD']);
    await writeFile(join(cwd, 'SKILL.md'), '---\nname: changed\n---\nChanged after review\n');
    await command(['add', 'SKILL.md']);
    await command(['-c', 'user.name=Registry fixture', '-c', 'user.email=registry-fixture@example.invalid', 'commit', '-m', 'moved']);
    // Git's native URL rewrite is an OS transport fixture. Both the target
    // adapter and the SCM clone/read/download owners remain production code.
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', `url.${pathToFileURL(cwd).href}.insteadOf`);
    vi.stubEnv('GIT_CONFIG_VALUE_0', targetUrl);
    const catalog = MarketplaceIndexSourceSnapshotV1Schema.parse({ source: {
      id: catalogSource.id, title: catalogSource.title, kind: 'curated', sourceUrl: catalogSource.url,
    }, freshness: { state: 'fresh', fetchedAtMs: 1 }, entries: [], diagnostics: [], picks: [
      { kind: 'skill', format: 'git', sourceUrl: targetUrl, itemId: '' },
    ] });
    const forbidden = async (): Promise<never> => { throw new Error('Non-GitHub targets must use the SCM owner'); };
    const http: RegistryHttpV1 = { getJson: async url => {
      expect(url).toBe(catalogSource.url); return { ok: true, value: catalog, fetchedAt: 1 };
    }, getText: forbidden, getBytes: forbidden };
    const daemon = createRegistryHostV1({ host: 'node', http, git: createRegistryGitProtocolV1({}), readSources: async () => BUILT_IN_REGISTRY_SOURCES_V1 });
    const handlers = new Map<string, RpcHandler>();
    registerMachineRegistriesRpcHandlers({ rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } }, createHost: () => daemon });
    const requests: RegistryFetchRequestV1[] = [];
    for (const platform of ['web', 'native'] as const) {
      const client = createRegistryHostV1({ host: platform, http, readSources: async () => BUILT_IN_REGISTRY_SOURCES_V1,
        daemonFetch: async raw => {
          const request = RegistryFetchRequestV1Schema.parse(JSON.parse(JSON.stringify(raw)));
          requests.push(request);
          const handler = handlers.get(RPC_METHODS.DAEMON_REGISTRIES_FETCH);
          if (!handler) throw new Error('Registry RPC registration missing');
          return RegistryFetchResponseV1Schema.parse(JSON.parse(JSON.stringify(await handler(request))));
        } });
      requests.length = 0;
      const page = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await client.execute('registries.items.list', {
        kind: 'skill', sourceIds: [catalogSource.id],
      }));
      expect(page.pages[0]?.items).toHaveLength(1);
      expect(requests).toEqual([]);
      const summary = page.pages[0]!.items[0]!;
      const read = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await client.execute('registries.items.read', {
        kind: 'skill', sourceId: catalogSource.id, itemId: summary.itemId, version: commit,
      }));
      expect(read.item).toMatchObject({ summary: { sourceId: catalogSource.id, version: commit },
        payload: { kind: 'skill', skill: { ref: { repo: targetUrl, commit }, skillMarkdown: expect.stringContaining('Reviewed content') } } });
      const files = await client.filesForPointer({ sourceId: catalogSource.id, itemId: summary.itemId, version: commit });
      expect(new TextDecoder().decode(files[0]!.bytes)).toContain('Reviewed content');
      expect(requests).toContainEqual({ op: 'files', kind: 'skill', sourceId: catalogSource.id, itemId: summary.itemId, version: commit });
      expect(requests.filter(request => request.op === 'read').every(request => request.version === commit)).toBe(true);
      expect(requests.every(request => 'sourceId' in request && request.sourceId === catalogSource.id)).toBe(true);
      expect(RegistryFetchRequestV1Schema.safeParse({ ...requests[0], source: catalogSource }).success).toBe(false);
    }
  } finally { vi.unstubAllEnvs(); await rm(cwd, { recursive: true, force: true }); }
});
