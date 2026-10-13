import { once } from 'node:events';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { Server } from 'socket.io';
import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { McpServersSettingsV1Schema } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { SpawnCapabilitiesPreviewSuccessV1Schema, SessionCapabilitiesGetOutputV1Schema } from '@happier-dev/protocol/actions/specs/sessionCapabilities';
import { PromptLibraryCatalogKeyV1Schema, PROMPT_LIBRARY_ROWS_ROUTE_V1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerMachineMcpServersRpcHandlers } from '@/api/machine/rpcHandlers.mcpServers';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { bootstrapAccountSettingsContext, resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { createSessionRecordFixture, createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { reloadConfiguration } from '@/configuration';
import { createCliActionDeps } from './createCliActionDeps';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { V2SessionRecordSchema } from '@happier-dev/protocol/sessions/control/contract';
import { readRpcErrorCode, RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpcErrors';
import { createSessionOwnerMetadataV1, createPlainSessionOwnerMetadataEnvelopeV1, projectSessionSharedMetadataV1,
  projectSessionOwnerCompatibilityViewV1, SessionMetadataOwnerPatchV1Schema, StoredSessionOwnerMetadataEnvelopeV1Schema,
  StoredSessionSharedMetadataV1Schema, SessionMetadataTuplePatchSuccessV1Schema, SessionMetadataVersionConflictV1Schema,
} from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

describe('Session capabilities composed Account and Machine seam', () => {
  it('previews Off items through real HTTP/Socket.IO and writes Account metadata while the machine is offline', async () => {
    await withTempDir('happier-impl-p2c-machine-composed-', async home => {
      const db = new DatabaseSync(':memory:');
      db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, metadata TEXT NOT NULL, revision INTEGER NOT NULL, ownerMetadata TEXT NOT NULL, agentState TEXT, agentRevision INTEGER NOT NULL)');
      const sessionId = 'c111111111111111111111111';
      const machineId = 'capabilities-machine';
      const metadata = createTestMetadata({ path: home, host: 'fixture', machineId, flavor: 'codex' });
      const owner = createSessionOwnerMetadataV1({ metadata });
      if (!owner.ok) throw new Error(`Invalid canonical metadata fixture: ${owner.unsupportedFields.join(',')}`);
      db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run(sessionId,
        JSON.stringify(projectSessionSharedMetadataV1({ metadata })), 1,
        JSON.stringify(createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata)), null, 0);
      const persistedMetadata = () => {
        const row = db.prepare('SELECT metadata, ownerMetadata FROM sessions WHERE id = ?').get(sessionId)!;
        const envelope = StoredSessionOwnerMetadataEnvelopeV1Schema.parse(JSON.parse(String(row.ownerMetadata)));
        if (envelope.t !== 'plain') throw new Error('Plain Account fixture changed mode');
        return projectSessionOwnerCompatibilityViewV1({ sharedMetadata: StoredSessionSharedMetadataV1Schema.parse(JSON.parse(String(row.metadata))),
          ownerMetadata: envelope.v });
      };
      const settings = McpServersSettingsV1Schema.parse({ v: 1, servers: [{ id: 'mcp-linear', name: 'linear', transport: 'http',
        remote: { url: 'https://example.test/mcp', headers: {} }, env: {}, createdAt: 1, updatedAt: 1 }], bindings: [{
          id: 'everywhere-off', serverId: 'mcp-linear', target: { t: 'allMachines' }, enabled: false, createdAt: 1, updatedAt: 1,
        }] });
      const catalog = { v: 1, servers: settings.servers, bindings: settings.bindings };
      const failures: unknown[] = [];
      const rpcResponses: unknown[] = [];
      let machineOnline = true;
      let accountSessionReadable = true;
      let relayMethodNotFound = false;
      const server = createServer((request, response) => { void (async () => {
        const path = new URL(request.url ?? '/', 'http://fixture.test').pathname;
        let text = ''; for await (const chunk of request) text += String(chunk);
        let result: unknown;
        let status = 200;
        if ((request.method === 'HEAD' || request.method === 'GET') && path === '/') result = {};
        else if (path === '/v1/account/encryption/currentness') result = { mode: 'plain', version: 0,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 };
        else if (path === '/v1/account/encryption') result = { mode: 'plain', updatedAt: 0 };
        else if (path === '/v2/account/settings') result = { version: 1, content: { t: 'plain', v: {} } };
        else if (path === '/v1/account/entity-rows/mcp') result = { status: 'present', revision: 1, content: { t: 'plain', v: catalog } };
        else if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) result = { status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({
          key, revision: 1, content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) } })) };
        else if (path === '/v1/artifacts') result = [];
        else if (path === `/v1/machines/${machineId}`) result = { machine: { id: machineId, kind: 'persistent', active: machineOnline,
          storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, revokedAt: null, replacedByMachineId: null } };
        else if (path === `/v2/sessions/${sessionId}` && request.method === 'GET') {
          const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
          if (!row) throw new Error('Missing test Session');
          if (!accountSessionReadable) { status = 503; result = { error: 'Session read unavailable' }; }
          else result = { session: V2SessionRecordSchema.parse(createSessionRecordFixture({ id: sessionId, active: false, encryptionMode: 'plain', share: null,
            metadataLayoutVersion: 1, metadata: String(row.metadata), metadataVersion: Number(row.revision),
            effectiveAccess: createSessionNotificationContextFixture(sessionId).effectiveAccess,
            ownerMetadata: StoredSessionOwnerMetadataEnvelopeV1Schema.parse(JSON.parse(String(row.ownerMetadata))),
            agentState: row.agentState === null ? null : String(row.agentState), agentStateVersion: Number(row.agentRevision) })) };
        } else if (path === `/v2/sessions/${sessionId}` && request.method === 'PATCH') {
          const body = SessionMetadataOwnerPatchV1Schema.parse(JSON.parse(text));
          const updated = db.prepare('UPDATE sessions SET metadata = ?, revision = revision + 1, ownerMetadata = ?, agentState = ?, agentRevision = agentRevision + 1 WHERE id = ? AND revision = ? AND agentRevision = ? AND ownerMetadata = ?')
            .run(body.sharedMetadata.ciphertext, JSON.stringify(body.ownerMetadata), body.agentState.ciphertext, sessionId,
              body.sharedMetadata.expectedVersion, body.agentState.expectedVersion, JSON.stringify(body.expectedOwnerMetadata));
          const row = db.prepare('SELECT revision, agentRevision FROM sessions WHERE id = ?').get(sessionId)!;
          status = updated.changes ? 200 : 409;
          result = updated.changes ? SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true, metadataLayoutVersion: 1,
            sharedMetadata: { version: Number(row.revision) }, agentState: { version: Number(row.agentRevision) } })
            : SessionMetadataVersionConflictV1Schema.parse({ code: 'session_metadata_version_conflict', metadataLayoutVersion: 1,
              sharedMetadata: { version: Number(row.revision) }, agentState: { version: Number(row.agentRevision) } });
        } else { throw new Error(`Unexpected composed Home route ${request.method} ${path}`); }
        response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(result));
      })().catch(error => { failures.push(error); response.writeHead(500); response.end('{}'); }); });
      const socketServer = new Server(server, { path: '/v1/updates/' });
      const manager = new RpcHandlerManager({ scopePrefix: machineId, encryptionMode: 'plain', logger: () => undefined });
      socketServer.on('connection', socket => socket.on(SOCKET_RPC_EVENTS.CALL, (request, ack) => {
        if (!machineOnline) { ack({ ok: false, error: 'RPC target unavailable', errorCode: 'target_unavailable' }); return; }
        if (relayMethodNotFound) { ack({ ok: false, error: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND, errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }); return; }
        void manager.handleRequest(request).then(result => { rpcResponses.push(result); ack({ ok: true, result }); }, error => ack({
          ok: false, error: error instanceof Error ? error.message : 'RPC call failed',
          ...(readRpcErrorCode(error) ? { errorCode: readRpcErrorCode(error) } : {}),
        }));
      }));
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing server address');
      const base = `http://127.0.0.1:${address.port}`;
      const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
      const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'capabilities-account' })).toString('base64url')}.signature`, encryption: null };
      let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
      try {
        env.patch({ HAPPIER_HOME_DIR: home, HAPPIER_SERVER_URL: base, HAPPIER_WEBAPP_URL: base }); reloadConfiguration();
        resetInMemoryAccountSettingsContextForTests();
        runtime = await createAdmittedPluginRuntimeFixture({ happyHomeDir: home, controller: pluginReloadController, runtimeOptions: { pluginIds: ['codex'] } });
        registerMachineMcpServersRpcHandlers({ rpcHandlerManager: manager, deps: { readCredentials: async () => credentials,
          detectProviderMcpServers: async () => ({ servers: [], warnings: [] }),
          bootstrapAccountSettingsContext: input => runWithServerHttpBaseUrl(base, () => bootstrapAccountSettingsContext(input)),
        } });
        await runWithServerHttpBaseUrl(base, () => bootstrapAccountSettingsContext({ credentials, mode: 'blocking', refresh: 'force' }));
        const deps = createCliActionDeps({ credentials, token: credentials.token, sessionId: 'cli-global', mode: 'plain', ctx: null });
        const executor = createActionExecutor(deps);
        const context = { surface: 'ui', authority: 'present_user' } as const;
        const preview = await executor.execute('sessions.spawn.capabilities.preview', { machineId, agentId: 'codex' }, context);
        expect(preview, JSON.stringify(failures.map(error => error instanceof Error ? error.message : error))).toMatchObject({ ok: true, result: { ok: true,
          mcp: { items: [{ id: 'mcp-linear', selected: false, reason: 'rule_off' }] } } });
        if (!preview.ok) throw new Error(preview.error);
        SpawnCapabilitiesPreviewSuccessV1Schema.parse(preview.result);
        const transport = await resolveSessionTransportContext({ credentials, idOrPrefix: sessionId });
        expect(transport).toMatchObject({ ok: true });
        if (!transport.ok) throw new Error(`Canonical fixture read failed: ${transport.code}`);
        const opened = tryDecryptSessionOwnerMetadataView({ credentials, accountEncryptionMode: transport.accountEncryptionCurrentness.mode,
          rawSession: transport.rawSession });
        expect(opened, JSON.stringify(transport.rawSession)).toMatchObject({ machineId, path: home, flavor: 'codex' });
        const stopped = await executor.execute('session.capabilities.get', { sessionId }, context);
        expect(stopped, JSON.stringify({ stopped, rpcResponses, failures: failures.map(error => error instanceof Error ? error.message : error) }))
          .toMatchObject({ ok: true, result: { ok: true, applyTiming: { mcp: { t: 'session_not_running' } } } });
        if (stopped.ok) SessionCapabilitiesGetOutputV1Schema.parse(stopped.result);
        machineOnline = false;
        const changed = await executor.execute('session.capabilities.set', { sessionId, kind: 'mcp_server', id: 'linear', state: 'on' }, context);
        expect(changed, JSON.stringify({ changed, failures: failures.map(error => error instanceof Error ? error.message : error) }))
          .toMatchObject({ ok: true, result: { ok: true, previous: 'inherit', applyTiming: { t: 'session_not_running' } } });
        expect(persistedMetadata()).toMatchObject({ mcpSelectionV1: { forceIncludeServerIds: ['mcp-linear'] } });
        expect(await executor.execute('session.capabilities.set', { sessionId, kind: 'native_skill', id: 'native-from-offline-machine', state: 'off' }, context))
          .toMatchObject({ ok: true, result: { ok: true, previous: 'inherit', applyTiming: { t: 'session_not_running' } } });
        expect(persistedMetadata()).toMatchObject({ skillSelectionV1: { excludeNativeSkillNames: ['native-from-offline-machine'] } });
        expect(await executor.execute('session.capabilities.get', { sessionId }, context))
          .toMatchObject({ ok: true, result: { ok: false, code: 'session_unavailable' } });
        machineOnline = true;
        expect(await executor.execute('session.capabilities.get', { sessionId }, context))
          .toMatchObject({ ok: true, result: { ok: true, mcp: { items: [{ id: 'mcp-linear', selected: true, reason: 'session_added' }] } } });
        const beforeReadFailure = persistedMetadata();
        accountSessionReadable = false;
        expect(await executor.execute('session.capabilities.get', { sessionId }, context))
          .toMatchObject({ ok: true, result: { ok: false, code: 'session_unavailable' } });
        expect(await executor.execute('session.capabilities.set', { sessionId, kind: 'mcp_server', id: 'linear', state: 'off' }, context))
          .toMatchObject({ ok: true, result: { ok: false, code: 'session_unavailable' } });
        expect(persistedMetadata()).toEqual(beforeReadFailure);
        accountSessionReadable = true;
        relayMethodNotFound = true;
        expect(await executor.execute('sessions.spawn.capabilities.preview', { machineId, agentId: 'codex' }, context))
          .toMatchObject({ ok: true, result: { ok: false, reason: 'invalid_input' } });
        relayMethodNotFound = false;
        manager.unregisterHandler(RPC_METHODS.DAEMON_MCP_SERVERS_PREVIEW);
        expect(await executor.execute('sessions.spawn.capabilities.preview', { machineId, agentId: 'codex' }, context))
          .toMatchObject({ ok: true, result: { ok: false, reason: 'invalid_input' } });
        expect(failures).toEqual([]);
      } finally {
        await runtime?.dispose();
        env.restore(); reloadConfiguration(); resetInMemoryAccountSettingsContextForTests();
        await new Promise<void>(resolve => socketServer.close(() => resolve()));
        server.closeAllConnections(); if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        db.close();
      }
    });
  });
});
