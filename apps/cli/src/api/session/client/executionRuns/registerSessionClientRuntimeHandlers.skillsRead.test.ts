import { once } from 'node:events';
import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { SkillReadResultV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillReadV1';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1, ProjectAccountRowListResponseV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveRunnerSkills } from '@/prompts/skills/runtime/resolveRunnerSkills';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { withTempDir } from '@/testkit/fs/tempDir';
import { registerSessionClientRuntimeHandlers } from './registerSessionClientRuntimeHandlers';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';

it('reads the real index plan through the owning Session RPC and strict skill consumer, then refuses a retired plan', async () => {
  const skillMd = '---\nname: review\ndescription: Review changes\n---\nFull instructions';
  const body = { v: 1, createdAtMs: 1, updatedAtMs: 1, entries: [
    { path: 'SKILL.md', contentBase64: Buffer.from(skillMd).toString('base64'), contentKind: 'utf8' },
    { path: 'references/note.bin', contentBase64: 'AAEC/w==', contentKind: 'binary', unixMode: 0o755 },
  ] };
  const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
  const credentials = { token, encryption: null } as const;
  const artifact = { id: 'selected', ownerAccountId: 'account', access: 'owner', encryptionMode: 'plain',
    header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_bundle.v2', title: 'Display title', bundleSchemaId: 'skills.skill_md_v1' }),
    body: encodePlainArtifactStoredContent({ body: JSON.stringify(body) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
    headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
  const requests: string[] = [];
  // HTTP is the actual Account persistence boundary; no domain owner or dispatcher is mocked.
  const home = createServer((request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname;
    requests.push(path);
    response.setHeader('Content-Type', 'application/json');
    if (path === '/v1/account/encryption') response.end(JSON.stringify({ mode: 'plain', updatedAt: 1 }));
    else if (path === '/v1/account/encryption/currentness') response.end(JSON.stringify({ mode: 'plain', version: 1,
      settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
    else if (path === '/v1/account/entity-rows/prompt-library') response.end(JSON.stringify({ status: 'listed',
      rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1,
        content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) } })) }));
    else if (path === '/v2/account/settings/history') response.end(JSON.stringify({ snapshots: [] }));
    else if (path === '/v1/account/entity-rows/profiles/transfer'
      || path === '/v1/account/entity-rows/registry-sources/transfer') response.end(JSON.stringify({ status: 'absent' }));
    else if (path === '/v1/artifacts') response.end(JSON.stringify([artifact]));
    else if (path === '/v1/artifacts/selected') response.end(JSON.stringify(artifact));
    else if (path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) response.end(JSON.stringify(
      ProjectAccountRowListResponseV1Schema.parse({ status: 'listed', coverage: 'complete', rows: [] })));
    else if (path === '/v2/account/settings') response.end(JSON.stringify({ version: 1, content: { t: 'plain', v: { schemaVersion: 6 } } }));
    else { response.statusCode = 404; response.end('{}'); }
  });
  home.listen(0, '127.0.0.1');
  await once(home, 'listening');
  const address = home.address();
  if (!address || typeof address === 'string') throw new Error('Missing Home address');
  const url = `http://127.0.0.1:${address.port}`;
  const foreignCredentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'focused-foreign-account' })).toString('base64url')}.signature`, encryption: null };
  const foreignScope = runWithServerHttpBaseUrl(url, () => resolveAccountSettingsScopeKey(foreignCredentials));
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
    settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: foreignScope });
  try {
    await withTempDir('happier-session-skills-rpc-', async directory => {
      const sessionId = 'session';
      const metadata = createTestMetadata({ path: directory, machineId: 'machine' });
      const plan = await runWithServerHttpBaseUrl(url, () => resolveRunnerSkills({
        ownerKey: sessionId, agentId: 'test-index-agent', machineId: 'machine', directory, home: directory,
        credentials, sessionMetadata: metadata, agentHasActionChannel: true, contributes: { catalogEntriesById: {} },
        accountSnapshot: { source: 'network', settings: accountSettingsParse({}), settingsVersion: 1, loadedAtMs: 1,
          settingsSecretsReadKeys: [], promptLibraryCatalog: { status: 'ready', rows: [{ revision: 1,
            record: { key: 'skill-rules', value: { v: 1, rules: [{ id: 'all', skillId: 'selected', target: { t: 'allMachines' },
              enabled: true, createdAt: 1, updatedAt: 1 }] } } }], tombstones: [], diagnostics: [] } },
      }, { artifacts: createCredentialedAccountArtifactStore(credentials) }));
      expect(plan.plan.plan).toBe('index');
      expect(plan.indexItems, JSON.stringify({ plan: plan.plan, unavailableReason: plan.unavailableReason }))
        .toEqual([expect.objectContaining({ skillId: 'selected', name: 'review' })]);
      let current = true;
      const rpc = new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain', logger: () => {} });
      const unexpectedWrite = async (): Promise<never> => { throw new Error('Unexpected transcript write'); };
      const registration = registerSessionClientRuntimeHandlers({
        rpcHandlerManager: rpc, token, serverId: 'home', serverUrl: url,
        readOwnerAccountCredentials: async () => credentials,
        getCurrentSessionSkillItems: () => current ? plan.plan.items.filter(item => item.state === 'delivered') : null,
        metadataPath: directory, metadata, sessionId, getSessionMetadata: () => metadata,
        enqueueSessionUserMessage: unexpectedWrite, enqueueUserTextMessageCommitted: unexpectedWrite,
        enqueueAgentMessageCommitted: unexpectedWrite, enqueueVoiceAgentTranscriptTurnCommitted: unexpectedWrite,
        sendAgentMessageEphemeral: () => { throw new Error('Unexpected ephemeral write'); },
        getTranscriptQueryContext: () => ({ encryptionMode: 'plain' }),
        persistVoiceAgentRunMetadataFromPublicRun: () => {}, socketEmitExecutionRunUpdated: () => {},
      });
      try {
        const input = { name: 'review', sessionId, file: 'references/note.bin' };
        const output = await rpc.handleRequest({ method: `${sessionId}:skills.read`, params: input, callerAuthority: 'present_user' });
        expect(output).toMatchObject({ skillId: 'selected' });
        const parsed = SkillReadResultV1Schema.parse(output);
        expect(parsed).toMatchObject({ skillId: 'selected', skillMd, file: { contentBase64: 'AAEC/w==', unixMode: 0o755 } });
        const reads = requests.filter(path => path === '/v1/artifacts/selected').length;
        current = false;
        expect(await rpc.handleRequest({ method: `${sessionId}:skills.read`, params: input, callerAuthority: 'present_user' }))
          .toMatchObject({ ok: false, errorCode: 'not_found' });
        expect(requests.filter(path => path === '/v1/artifacts/selected')).toHaveLength(reads);
        expect(getActiveAccountSettingsSnapshot()?.scopeKey).toBe(foreignScope);
      } finally { await registration.dispose(); }
    });
  } finally {
    resetActiveAccountSettingsSnapshotForTests();
    home.closeAllConnections();
    await new Promise<void>((resolve, reject) => home.close(error => error ? reject(error) : resolve()));
  }
});
