import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { McpServerCatalogRowMutationV1Schema, type McpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createCliActionDeps } from './createCliActionDeps';

afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

describe('CLI MCP Actions through admitted catalog persistence', () => {
  it('executes catalog and rules changes through the CLI Action factory without a retained-root write', async () => {
    const base = 'https://mcp-actions.example.test';
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'mcp-actions-account' })).toString('base64url')}.signature`, encryption: null };
    await runWithServerHttpBaseUrl(base, async () => {
      setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({ mcpServersStrictMode: true }),
        rawSettings: { mcpServersStrictMode: true }, settingsVersion: 7, loadedAtMs: 1, settingsSecretsReadKeys: [],
        scopeKey: resolveAccountSettingsScopeKey(credentials) });
      let catalog: McpServerCatalogV1 = { v: 1, servers: [], bindings: [] };
      let revision = 1;
      // Replace Home HTTP only: Action admission, semantics, mode/currentness,
      // opening, row CAS request and response validation are real.
      vi.spyOn(axios, 'get').mockImplementation(async input => {
        const path = new URL(String(input)).pathname;
        if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
          settingsVersion: 7, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        if (path === '/v1/account/entity-rows/mcp') return { status: 200, data: { status: 'present', revision, content: { t: 'plain', v: catalog } } };
        if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: { mcpServersStrictMode: true } }, version: 7 } };
        if (path === '/v1/account/entity-rows/profiles/transfer') return { status: 200, data: { status: 'absent' } };
        if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
        throw new Error(`Unexpected Home read: ${path}`);
      });
      const postedPaths: string[] = [];
      vi.spyOn(axios, 'post').mockImplementation(async (input, body) => {
        const path = new URL(String(input)).pathname;
        postedPaths.push(path);
        expect(path).toBe('/v1/account/entity-rows/mcp');
        const mutation = McpServerCatalogRowMutationV1Schema.parse(body);
        expect(mutation.expectedRevision).toBe(revision);
        expect(mutation.content?.t).toBe('plain');
        if (mutation.content?.t !== 'plain') throw new Error('Expected plain Account row');
        catalog = mutation.content.v;
        return { status: 200, data: { status: 'updated', revision: ++revision, cursor: revision } };
      });
      const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials,
        serverId: 'mcp-home', serverHttpBaseUrl: base, sessionId: 'session', mode: 'plain', ctx: null }));
      const actionsSettings = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: {
        'mcp.servers.create': ['cli'], 'mcp.servers.update': ['cli'], 'mcp.servers.delete': ['cli'],
        'mcp.servers.duplicate': ['cli'], 'mcp.rules.set': ['cli'],
      } });
      const context = { surface: 'cli', authority: 'present_user', serverId: 'mcp-home', actionsSettings, actionCaller: { kind: 'host' } } as const;
      const entry = { id: 'server', name: 'server', transport: 'stdio', stdio: { command: 'mcp-tool', args: [] },
        env: { TOKEN: { t: 'literal', v: 'private' } }, createdAt: 1, updatedAt: 1 } as const;
      expect(await executor.execute('mcp.servers.create', { entry, expectedRevision: 1 }, context))
        .toEqual({ ok: true, result: { status: 'updated', revision: 2, cursor: 2 } });
      expect(await executor.execute('mcp.servers.read', { serverId: 'server' }, context)).toMatchObject({ ok: true,
        result: { status: 'present', complete: true, authority: 'active', revision: 2, server: entry } });
      expect(await executor.execute('mcp.servers.update', { entry: { ...entry, name: 'changed' }, expectedRevision: 1 }, context))
        .toEqual({ ok: true, result: { status: 'conflict', revision: 2 } });
      const rules = (state: 'on' | 'off' | 'inherit', place: { t: 'machine'; machineId: string } | { t: 'allMachines' } = { t: 'machine', machineId: 'exact-machine' }) =>
        executor.execute('mcp.rules.set', { items: [{ serverId: 'server' }], change: { kind: 'write', write: { place, state } } }, context);
      expect(await rules('off')).toMatchObject({ ok: true, result: { ok: true, revision: 3, items: [{ serverId: 'server' }] } });
      const configOverrides = [{ target: { t: 'machine', machineId: 'exact-machine' }, envPatch: { TOKEN: null } }] as const;
      expect(await executor.execute('mcp.servers.update', { entry, configOverrides, expectedRevision: 3 }, context))
        .toEqual({ ok: true, result: { status: 'updated', revision: 4, cursor: 4 } });
      expect(await rules('on')).toMatchObject({ ok: true, result: { ok: true, revision: 5 } });
      expect(await executor.execute('mcp.servers.read', { serverId: 'server' }, context)).toMatchObject({ ok: true,
        result: { server: { configOverrides }, bindings: [{ enabled: true, target: { t: 'allMachines' } },
          { enabled: true, target: { t: 'machine', machineId: 'exact-machine' } }] } });
      expect(await executor.execute('mcp.servers.delete', { serverId: 'server', removeBindings: false, expectedRevision: 5 }, context))
        .toEqual({ ok: false, errorCode: 'invalid-mutation', error: 'invalid-mutation' });
      expect(await rules('inherit')).toMatchObject({ ok: true, result: { ok: true, revision: 6 } });
      expect(await rules('inherit', { t: 'allMachines' })).toMatchObject({ ok: true, result: { ok: true, revision: 7 } });
      const copy = { ...entry, id: 'copy', name: 'copy' };
      expect(await executor.execute('mcp.servers.duplicate', { serverId: 'server', entry: copy, where: { kind: 'replace', rules: [] }, expectedRevision: 7 }, context))
        .toEqual({ ok: true, result: { status: 'updated', revision: 8, cursor: 8 } });
      expect(await executor.execute('mcp.servers.delete', { serverId: 'server', removeBindings: false, expectedRevision: 8 }, context))
        .toEqual({ ok: true, result: { status: 'updated', revision: 9, cursor: 9 } });
      expect(await executor.execute('mcp.servers.update', { entry: { ...copy, name: 'updated' }, expectedRevision: 9 }, context))
        .toEqual({ ok: true, result: { status: 'updated', revision: 10, cursor: 10 } });
      expect(await executor.execute('mcp.servers.list', {}, context)).toMatchObject({ ok: true, result: {
        status: 'ready', authority: 'active', revision: 10,
        catalog: { v: 1, servers: [{ id: 'copy', name: 'updated', transport: 'stdio', createdAt: 1, updatedAt: 1 }], bindings: [] },
      } });
      expect(await executor.execute('mcp.servers.read', { serverId: 'server' }, context))
        .toEqual({ ok: true, result: { status: 'not-found', serverId: 'server', revision: 10 } });
      expect(new Set(postedPaths)).toEqual(new Set(['/v1/account/entity-rows/mcp']));
    });
  });
});
