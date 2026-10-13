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

const boundary = await vi.hoisted(async () => {
  const { createTempDir } = await import('@/testkit/fs/tempDir');
  const taskHome = await createTempDir('happier-skills-read-');
  vi.stubEnv('HAPPIER_HOME_DIR', taskHome);
  return { taskHome, get: vi.fn() };
});
vi.mock('axios', () => ({ default: { get: boundary.get } }));

describe('CLI skills.read real dependencies', () => {
  beforeEach(() => { resetActiveAccountSettingsSnapshotForTests(); boundary.get.mockReset(); });
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
    ] };
    const { createSkillStore } = await import('@/prompts/skills/store/skillStore');
    const items = [{ skillId: 'selected', name: 'review', digest: computePromptBundleDigestV1(body), files: body.entries }];
    const ensured = await createSkillStore({ happyHomeDir: boundary.taskHome }).ensureSkillSessionDir({
      ownerKey: 'active-session', items, nativeDisables: [],
    });
    expect(ensured.failed).toEqual([]);
    const sessionItems = items.map(({ skillId, name, digest }) => ({ skillId, name, digest }));
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
      sessionId: 'active-session', serverId: 'home', serverHttpBaseUrl: 'https://home.example.test',
      getCurrentSessionSkillItems: () => currentItems }));
    try {
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
