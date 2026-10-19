import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createCliActionDeps } from './createCliActionDeps';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1, PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { createServer } from 'node:http';
import { writeDaemonState } from '@/persistence';
import { RecordSkillUseInputSchema, RecordSkillUseResultSchema } from '@/prompts/skills/store/controlRoutes';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod/mini';
import { createHappierToolInventory } from '@/agent/tools/happierTools/listBuiltInHappierTools';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { prepareHappierMcpToolInventory, registerHappierMcpBuiltInTools } from '@/mcp/server/registerHappierMcpBuiltInTools';
import { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { SkillReadInputV1Schema, SkillReadResultV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillReadV1';
import { bindContextualActionToolInput } from '@/agent/tools/happierTools/actionToolContext';

const boundary = await vi.hoisted(async () => {
  const { createTempDir } = await import('@/testkit/fs/tempDir');
  const taskHome = await createTempDir('happier-skills-read-');
  vi.stubEnv('HAPPIER_HOME_DIR', taskHome);
  return { taskHome, get: vi.fn(), post: vi.fn() };
});
vi.mock('axios', () => ({ default: { get: boundary.get, post: boundary.post } }));

describe('CLI skills.read real dependencies', () => {
  beforeEach(() => { resetActiveAccountSettingsSnapshotForTests(); boundary.get.mockReset(); boundary.post.mockReset(); });
  afterAll(async () => { const { createSkillStore } = await import('@/prompts/skills/store/skillStore');
    const store = createSkillStore({ happyHomeDir: boundary.taskHome });
    await store.releaseSkillSessionDirs('active-session');
    await store.collectSkillCache({ libraryDigests: [] });
    const { removeTempDir } = await import('@/testkit/fs/tempDir');
    await removeTempDir(boundary.taskHome); vi.unstubAllEnvs(); });
  it('reads the delivered session identity then decrypts the selected Artifact through the real store', async () => {
    const { computePromptBundleDigestV1 } = await import('@happier-dev/protocol/prompts/library/promptLibraryDigests');
    const skillMd = '---\nname: review\ndescription: Review\n---\nFull instructions';
    const body = { v: 1 as const, createdAtMs: 1, updatedAtMs: 1, entries: [
      { path: 'SKILL.md', contentBase64: Buffer.from(skillMd).toString('base64'), contentKind: 'utf8' as const },
      { path: 'references/note.bin', contentBase64: 'AAEC/w==', contentKind: 'binary' as const, unixMode: 0o755 },
      { path: 'scripts/check.py', contentBase64: Buffer.from('print("QA_SHIP_SCRIPT_OK")\n').toString('base64'), contentKind: 'utf8' as const, unixMode: 0o755 },
    ] };
    const { createSkillStore } = await import('@/prompts/skills/store/skillStore');
    const items = [{ skillId: 'selected', name: 'review', digest: computePromptBundleDigestV1(body), files: body.entries }];
    const ensured = await createSkillStore({ happyHomeDir: boundary.taskHome }).ensureSkillSessionDir({
      ownerKey: 'active-session', items, nativeDisables: [],
    });
    expect(ensured.failed).toEqual([]);
    const sessionItems = items.map(({ skillId, name, digest }) => ({ skillId, name, digest }));
    // An unrelated plugin source outage must not block an addressed Session skill.
    // The real Account plugin reader remains active beneath this HTTP boundary.
    boundary.post.mockRejectedValue(new Error('Plugin inventory HTTP unavailable'));
    boundary.get.mockImplementation(async (url: string) => ({ status: 200, data:
      url.endsWith(PROMPT_LIBRARY_ROWS_ROUTE_V1) ? { status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({
        key, revision: 1, content: { t: 'plain', v: key === 'skill-usage' ? { key, value: { v: 1, lastUsedAt: { selected: 123 } } } : emptyPromptLibraryRecordV1(key) },
      })) } : url.endsWith('/v2/account/settings') ? { content: { t: 'plain', v: {} }, version: 1 }
      : url.endsWith('/v1/account/encryption') ? { mode: 'plain', updatedAt: 1 }
      : url.endsWith('/v1/artifacts/selected') ? { id: 'selected', ownerAccountId: 'account', access: 'owner', encryptionMode: 'plain',
        header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_bundle.v2', title: 'Review', bundleSchemaId: 'skills.skill_md_v1' }),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify(body) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }
      : { mode: 'plain', version: 1, settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 },
    }));
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
    runWithServerHttpBaseUrl('https://home.example.test', () => setActiveAccountSettingsSnapshot({ source: 'network',
      scopeKey: resolveAccountSettingsScopeKey({ token, encryption: null }), settings: accountSettingsParse({}), rawSettings: {},
      settingsVersion: 1, settingsSecretsReadKeys: [], loadedAtMs: 1 }));
    const recorded: unknown[] = [];
    const daemon = createServer(async (request, response) => {
      if (request.url !== '/skills/usage') { response.writeHead(404).end(); return; }
      let body = ''; for await (const chunk of request) body += chunk;
      recorded.push(RecordSkillUseInputSchema.parse(JSON.parse(body))); response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(RecordSkillUseResultSchema.parse({ ok: true })));
    });
    await new Promise<void>(resolve => daemon.listen(0, '127.0.0.1', resolve));
    const address = daemon.address(); if (!address || typeof address === 'string') throw new Error('Missing daemon fixture address');
    writeDaemonState({ pid: process.pid, httpPort: address.port, startedAt: Date.now(), startedWithCliVersion: 'test', controlToken: 'test' });
    let currentItems: typeof sessionItems | null = sessionItems;
    const executor = createActionExecutor(createCliActionDeps({ token, credentials: { token, encryption: null },
      sessionId: 'active-session', mode: 'plain', ctx: null, serverId: 'home', serverHttpBaseUrl: 'https://home.example.test',
      getCurrentSessionSkillItems: () => currentItems }));
    try {
    const inventory = createHappierToolInventory({ surface: 'agent', isActionEnabled: () => true, actionsSettings: null });
    const toolInventory = prepareHappierMcpToolInventory({ sessionId: 'active-session', inventory: {
      ...inventory, tools: inventory.tools.filter(tool => tool.name === 'skills_read'),
    } });
    const bridge = createActionToolExecutorBridge({ executor, surface: 'agent', actionToolNameToId: toolInventory.actionToolNameToId });
    const mcpServer = new McpServer({ name: 'skill-read-contract', version: '1' });
    registerHappierMcpBuiltInTools({ registerTool: (name, meta, handler) => {
      mcpServer.registerTool(name, meta as { inputSchema: z.ZodMiniType }, async (args, extra) => CallToolResultSchema.parse(await handler(args, extra)));
    } }, { sessionId: 'active-session', surface: 'agent', toolInventory,
      deps: { ...bridge, resolveActionOptions: args => bridge.resolveActionOptions(args, 'active-session'),
        changeTitle: async () => ({ success: true }) } });
    const client = new Client({ name: 'skill-read-contract', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await mcpServer.connect(serverTransport);
      await client.connect(clientTransport);
      const advertised = (await client.listTools()).tools.find(tool => tool.name === 'skills_read');
      if (!advertised) throw new Error('skills_read was not advertised');
      expect(advertised.inputSchema.type).toBe('object');
      for (const key of ['oneOf', 'anyOf', 'allOf']) expect(advertised.inputSchema).not.toHaveProperty(key);
      const acceptsAdvertisedInput = compilePluginJsonSchema(advertised.inputSchema);
      // These are the actual name/id requests recorded from the SHIP-03 Codex Agent.
      // Both must survive the advertised MCP validator, contextual binding and real read owner.
      for (const identity of [{ name: 'review' }, { skillId: 'selected' }]) {
        const args = { ...identity, includeFileContents: true };
        expect(acceptsAdvertisedInput(args)).toBe(true);
        expect(SkillReadInputV1Schema.safeParse(bindContextualActionToolInput({ actionId: 'skills.read', input: args,
          context: { defaultSessionId: 'active-session' } })).success).toBe(true);
        const reply = await client.callTool({ name: 'skills_read', arguments: args });
        expect(reply, JSON.stringify(reply)).toMatchObject({ isError: false, structuredContent: {
          skillId: 'selected', skillMd, fileContents: body.entries,
        } });
        expect(SkillReadResultV1Schema.parse(reply.structuredContent).files).toContainEqual({ path: 'scripts/check.py',
          bytes: Buffer.from('print("QA_SHIP_SCRIPT_OK")\n').length, unixMode: 0o755 });
      }
      expect(await client.callTool({ name: 'skills_read', arguments: { name: 'review', file: 'scripts/check.py' } }))
        .toMatchObject({ isError: false, structuredContent: { skillId: 'selected',
          file: { path: 'scripts/check.py', contentBase64: body.entries[2]!.contentBase64, unixMode: 0o755 } } });
      // Union correlations remain strict at the real MCP call boundary.
      expect(await client.callTool({ name: 'skills_read', arguments: { name: 'review', skillId: 'selected' } }))
        .toMatchObject({ isError: true });
      expect(acceptsAdvertisedInput({ name: 'review', sessionId: '' })).toBe(false);
      expect(acceptsAdvertisedInput({ name: 'review', unexpected: true })).toBe(false);
      expect(await client.callTool({ name: 'skills_read', arguments: { name: 'outside', includeFileContents: true } }))
        .toMatchObject({ isError: true });
    } finally { await client.close(); await mcpServer.close(); }
    recorded.length = 0;
    const result = await executor.execute('skills.read', { name: 'review', sessionId: 'active-session', file: 'references/note.bin' },
      { surface: 'mcp', authority: 'account_automation' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: {
        skillId: 'selected', skillMd, lastUsedAt: 123, file: { contentBase64: 'AAEC/w==', unixMode: 0o755 },
      } });
    expect(recorded).toEqual([{ skillIds: ['selected'], account: { accountId: 'account', serverHttpBaseUrl: 'https://home.example.test' } }]);
    await executor.execute('skills.read', { skillId: 'selected' }, { surface: 'ui' });
    const reads = boundary.get.mock.calls.filter(([url]) => url.endsWith('/v1/artifacts/selected')).length;
    expect(await executor.execute('skills.read', { name: 'outside', sessionId: 'active-session' }, { surface: 'mcp' }))
      .toMatchObject({ ok: false, errorCode: 'not_found' });
    expect(boundary.get.mock.calls.filter(([url]) => url.endsWith('/v1/artifacts/selected'))).toHaveLength(reads);
    expect(await executor.execute('skills.read', { name: 'review', sessionId: 'active-session', file: 'missing' }, { surface: 'mcp' }))
      .toMatchObject({ ok: false, errorCode: 'not_found' });
    currentItems = [{ ...sessionItems[0]!, skillId: 'plugin:external/review' }];
    expect(await executor.execute('skills.read', { name: 'review', sessionId: 'active-session' }, { surface: 'mcp' }))
      .toMatchObject({ ok: false, errorCode: 'skill_content_unavailable' });
    currentItems = [{ ...sessionItems[0]!, digest: 'sha256:stale' }];
    expect(await executor.execute('skills.read', { name: 'review', sessionId: 'active-session' }, { surface: 'mcp' }))
      .toMatchObject({ ok: false, errorCode: 'not_found' });
    currentItems = sessionItems;
    const homeRead = boundary.get.getMockImplementation()!;
    boundary.get.mockImplementation(async (url: string, ...args: unknown[]) => {
      const result = await homeRead(url, ...args);
      if (url.endsWith('/v1/artifacts/selected')) currentItems = null;
      return result;
    });
    expect(await executor.execute('skills.read', { name: 'review', sessionId: 'active-session' }, { surface: 'mcp' }))
      .toMatchObject({ ok: false, errorCode: 'not_found' });
    expect(recorded).toEqual([{ skillIds: ['selected'], account: { accountId: 'account', serverHttpBaseUrl: 'https://home.example.test' } }]);
    } finally { await new Promise<void>((resolve, reject) => daemon.close(error => error ? reject(error) : resolve())); }
  });
});
