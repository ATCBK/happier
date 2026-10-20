import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import axios from 'axios';
import { describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';

// Prepare the real registration graph outside the individual workload deadline.
await import('@/plugins/testkit/admittedRuntime');
await import('./memoryWorker');
await import('@/api/session/external/leases/createExternalSessionObservationDaemonProjection');

describe('registered native transcript source observation', () => {
  it.each([
    { agentId: 'codex', pluginId: 'happier.agent.codex' },
    { agentId: 'pi', pluginId: 'happier.agent.pi' },
    { agentId: 'ohMyPi', pluginId: 'happier.agent.ohmypi' },
    { agentId: 'antigravity', pluginId: 'happier.agent.antigravity' },
    { agentId: 'kilo', pluginId: 'happier.agent.kilo' },
    { agentId: 'gemini', pluginId: 'happier.agent.gemini' },
    { agentId: 'qwen', pluginId: 'happier.agent.qwen' },
    { agentId: 'fx', pluginId: 'happier.agent.fx' },
    { agentId: 'auggie', pluginId: 'happier.agent.auggie' },
    { agentId: 'copilot', pluginId: 'happier.agent.copilot' },
    { agentId: 'droid', pluginId: 'happier.agent.droid' },
    { agentId: 'codebuddy', pluginId: 'happier.agent.codebuddy' },
    { agentId: 'cursor', pluginId: 'happier.agent.cursor' },
    { agentId: 'grok', pluginId: 'happier.agent.grok' },
    { agentId: 'kiro', pluginId: 'happier.agent.kiro' },
    { agentId: 'kimi', pluginId: 'happier.agent.kimi' },
    { agentId: 'devin', pluginId: 'happier.agent.devin' },
  ])('$agentId indexes append and removal through the shared source observer', async ({ agentId, pluginId }) => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-memory-source-observation-'));
    const agentDir = join(directory, 'agent');
    const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'PI_CODING_AGENT_DIR', 'HOME', 'USERPROFILE', 'XDG_DATA_HOME', 'GEMINI_CLI_HOME', 'QWEN_RUNTIME_DIR', 'COPILOT_HOME', 'CODEBUDDY_CONFIG_DIR', 'GROK_HOME', 'KIRO_HOME', 'KIMI_CODE_HOME', 'CODEX_HOME', 'HAPPIER_CODEX_HOME']);
    env.patch({ HAPPIER_HOME_DIR: join(directory, 'home'), HAPPIER_SERVER_URL: 'https://home.test',
      HAPPIER_WEBAPP_URL: 'https://home.test', PI_CODING_AGENT_DIR: agentDir, HOME: directory, USERPROFILE: directory,
      XDG_DATA_HOME: join(directory, 'data'), GEMINI_CLI_HOME: directory, QWEN_RUNTIME_DIR: join(directory, '.qwen'),
      COPILOT_HOME: join(directory, '.copilot'), CODEBUDDY_CONFIG_DIR: join(directory, '.codebuddy'),
      GROK_HOME: join(directory, '.grok'), KIRO_HOME: join(directory, '.kiro'), KIMI_CODE_HOME: join(directory, '.kimi-code'),
      CODEX_HOME: join(directory, '.codex'), HAPPIER_CODEX_HOME: join(directory, '.codex') });
    vi.resetModules();
    // Home HTTP and OS watch delivery are the only controlled boundaries.
    const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/profile') return { status: 200, data: { id: 'account', connectedServicesV2: [] } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      if (path === '/v2/sessions') return { status: 200, data: { sessions: [], nextCursor: null, hasNext: false } };
      throw new Error(`Unexpected native worker HTTP path: ${path}`);
    });
    let runtime: Awaited<ReturnType<typeof import('@/plugins/testkit/admittedRuntime').createAdmittedPluginRuntimeFixture>> | undefined;
    let worker: Awaited<ReturnType<typeof import('./memoryWorker').startMemoryWorker>> | undefined;
    let observation: ReturnType<typeof import('@/api/session/external/leases/createExternalSessionObservationDaemonProjection').createExternalSessionObservationDaemonProjection> | undefined;
    const fileChanges = new Map<string, (path: string) => void>();
    const topologyChanges = new Map<string, (path?: string) => void>();
    let devinFixture: ReturnType<typeof import('../../../../../packages/plugins/devin/src/agent/externalSessions/__fixtures__/nativeSession.test-support').createDevinNativeFixture> | undefined;
    try {
      const isCodex = agentId === 'codex';
      const isAntigravity = agentId === 'antigravity';
      const isKilo = agentId === 'kilo';
      const isGemini = agentId === 'gemini';
      const isQwen = agentId === 'qwen';
      const isFx = agentId === 'fx';
      const isAuggie = agentId === 'auggie';
      const isCopilot = agentId === 'copilot';
      const isDroid = agentId === 'droid';
      const isCodeBuddy = agentId === 'codebuddy';
      const isCursor = agentId === 'cursor';
      const isGrok = agentId === 'grok';
      const isKiro = agentId === 'kiro';
      const isKimi = agentId === 'kimi';
      const isDevin = agentId === 'devin';
      const kimiFixture = isKimi ? await import('../../../../../packages/plugins/kimi/src/agent/externalSessions/__fixtures__/kimiCode.test-support') : null;
      const nativeSessionId = '8b6e1959-546e-4a3b-a6c2-4c1d6109f210';
      const kiloRoot = join(directory, 'data', 'kilo', 'storage');
      const transcriptPath = isCodex ? join(directory, '.codex', 'sessions', `rollout-2026-10-20T10-00-00-${nativeSessionId}.jsonl`)
        : isDevin ? join(directory, 'data', 'devin', 'cli', 'sessions.db')
        : isKimi ? join(directory, '.kimi-code', 'sessions', 'wd_fixture_123', 'session_fixture', 'agents', 'main', 'wire.jsonl')
        : isCursor ? join(directory, '.cursor', 'projects', 'repo', 'agent-transcripts', `${nativeSessionId}.jsonl`)
        : isGrok ? join(directory, '.grok', 'sessions', 'hashed-workspace', nativeSessionId, 'chat_history.jsonl')
        : isKiro ? join(directory, '.kiro', 'sessions', 'cli', `${nativeSessionId}.jsonl`)
        : isCopilot ? join(directory, '.copilot', 'session-state', 'native', 'events.jsonl')
        : isDroid ? join(directory, '.factory', 'sessions', '-repo', 'native.jsonl')
        : isCodeBuddy ? join(directory, '.codebuddy', 'projects', '-repo', 'native.jsonl')
        : isAuggie ? join(directory, '.augment', 'sessions', 'native-session.json')
        : isFx ? join(directory, '.fx', 'sessions', 'native', 'events.jsonl')
        : isKilo ? join(kiloRoot, 'session', 'project', 'ses_fixture.json') : isAntigravity
        ? join(directory, '.gemini', 'antigravity-cli', 'brain', 'native', '.system_generated', 'logs', 'transcript_full.jsonl')
        : isGemini ? join(directory, '.gemini', 'tmp', 'project', 'chats', 'session-native-8b6e1959.jsonl')
        : isQwen ? join(directory, '.qwen', 'projects', '-repo', 'chats', `${nativeSessionId}.jsonl`)
        : join(agentDir, 'sessions', '-repo', '2026-10-20T10-00-00-000Z_native.jsonl');
      await mkdir(dirname(transcriptPath), { recursive: true });
      const fxResultName = 'result-read_file-1111111111111111-2222222222222222.txt';
      const fxResultPath = join(dirname(transcriptPath), 'tool-results', fxResultName);
      if (isFx) {
        await mkdir(dirname(fxResultPath), { recursive: true });
        await writeFile(fxResultPath, 'olivine native output');
      }
      const timestamp = new Date().toISOString();
      const row = (id: string, parentId: string | null, text: string) => isCodex
        ? JSON.stringify({ type: 'response_item', timestamp, payload: { type: 'message', role: 'user',
          content: [{ type: 'input_text', text }] } }) + '\n'
        : kimiFixture ? kimiFixture.kimiWire([kimiFixture.kimiUser(text)]) : isFx
        ? [
          { schema_version: 3, seq: id === 'first' ? 1 : 5, timestamp_ms: Date.now(), event: { user: { text, images: [] } } },
          ...(id === 'first' ? [
            { schema_version: 3, seq: 2, timestamp_ms: Date.now(), event: { tool_call: { call_id: 'call-1', tool_name: 'read_file', arguments_json: '{}' } } },
            { schema_version: 3, seq: 3, timestamp_ms: Date.now(), event: { tool_result: { call_id: 'call-1', tool_name: 'read_file',
              status: 'success', artifact_ref: fxResultName, stored_bytes: 21, completeness: 'complete' } } },
          ] : []),
          { schema_version: 3, seq: id === 'first' ? 4 : 6, timestamp_ms: Date.now(), event: { turn_completed: { files: [], turn_summary: null } } },
        ].map(value => JSON.stringify(value)).join('\n') + '\n'
        : JSON.stringify(isAntigravity
        ? { id, type: 'USER_INPUT', text }
        : isCursor ? { role: 'user', message: { content: [{ type: 'text', text }] } }
        : isGrok ? { type: 'user', content: [{ type: 'text', text }], timestamp }
        : isKiro ? { version: 'v1', kind: 'Prompt', data: { content: [{ kind: 'text', data: text }], meta: { timestamp: Date.now() / 1000 } } }
        : isCopilot ? { id, parentId, type: 'user.message', timestamp, data: { content: text } }
        : isCodeBuddy ? { id, parentId, type: 'message', role: 'user', content: [{ type: 'input_text', text }], timestamp, sessionId: 'native' }
        : isGemini ? { id, type: 'user', timestamp, content: text }
        : isQwen ? { uuid: id, parentUuid: parentId, sessionId: nativeSessionId, timestamp, version: '0.25.3',
          type: 'user', cwd: '/repo', message: { role: 'user', parts: [{ text }] } }
        : { type: 'message', id, parentId, timestamp, message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n';
      const header = isCodex ? JSON.stringify({ type: 'session_meta', timestamp, payload: { id: nativeSessionId,
        timestamp, cwd: '/repo', source: 'cli', originator: 'codex_cli_rs', cli_version: '0.162.1' } }) + '\n'
        : kimiFixture ? kimiFixture.kimiWire([kimiFixture.kimiMetadata]) : isCopilot ? JSON.stringify({ id: 'start', type: 'session.start', timestamp, data: { sessionId: 'native', version: 1,
        producer: 'copilot-agent', copilotVersion: '1.0.100', startTime: timestamp, context: { cwd: '/repo' } } }) + '\n'
        : isDroid ? JSON.stringify({ type: 'session_start', version: 2, id: 'native', cwd: '/repo' }) + '\n'
        : isGemini ? JSON.stringify({ sessionId: nativeSessionId, projectHash: 'project', startTime: timestamp, lastUpdated: timestamp }) + '\n'
        : isAntigravity || isQwen || isFx || isCodeBuddy || isCursor || isGrok || isKiro ? '' : JSON.stringify({ type: 'session', version: 3, id: 'native', timestamp, cwd: '/repo' }) + '\n';
      // Sanitised paired-store vectors from Orca a18b44bfc0; producing CLI
      // versions are unknown, as recorded beside the plugin-owned fixtures.
      const sidecarPath = isKimi ? join(directory, '.kimi-code', 'sessions', 'wd_fixture_123', 'session_fixture', 'state.json')
        : isCursor ? join(directory, '.cursor', 'chats', 'workspace-hash', nativeSessionId, 'meta.json')
        : isGrok ? join(dirname(transcriptPath), 'summary.json')
        : isKiro ? transcriptPath.slice(0, -1) : null;
      if (sidecarPath && !isKimi) {
        await mkdir(dirname(sidecarPath), { recursive: true });
        await writeFile(sidecarPath, JSON.stringify(isCursor
          ? { schemaVersion: 1, title: 'Ordinary title', cwd: '/repo', createdAtMs: Date.now(), updatedAtMs: Date.now(), hasConversation: true }
          : isGrok ? { info: { id: nativeSessionId, cwd: '/repo' }, generated_title: 'Ordinary title', created_at: timestamp, updated_at: timestamp }
          : { session_id: nativeSessionId, cwd: '/repo', title: 'Ordinary title', created_at: timestamp, updated_at: timestamp }));
      }
      if (isFx) {
        // Vendor-source schema-4 metadata; body frames use conversation schema 3.
        await writeFile(join(dirname(transcriptPath), 'session.json'), JSON.stringify({ schema_version: 4,
          id: 'native', origin_workspace_root: '/repo', workspace_root: '/repo', created_at_ms: Date.now(), updated_at_ms: Date.now(),
          conversation_language: 'en', provider: 'openai', model: 'fixture-model', effort: 'medium', fast_mode: false,
          title: 'ordinary title', subagent_child: false }));
      }
      const putKilo = async (path: string, value: unknown) => {
        await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value));
      };
      const writeAuggie = async (texts: readonly string[]) => {
        const { buildAuggieNativeSession } = await import('../../../../../packages/plugins/auggie/src/agent/surfaces/sessions/external/__fixtures__/nativeSession.test-support');
        await writeFile(transcriptPath, JSON.stringify(buildAuggieNativeSession(texts)));
      };
      if (isDevin) {
        const { createDevinNativeFixture } = await import('../../../../../packages/plugins/devin/src/agent/externalSessions/__fixtures__/nativeSession.test-support');
        devinFixture = createDevinNativeFixture(dirname(transcriptPath), ['quartz initial native message']);
      } else if (kimiFixture) {
        await kimiFixture.writeKimiFixture(join(directory, '.kimi-code'));
        await appendFile(transcriptPath, row('first', null, 'quartz initial native message'));
      } else if (isAuggie) {
        await writeAuggie(['quartz initial native message']);
      } else if (isKilo) {
        // Pinned vendor schema vector, shared with the real plugin owner suite.
        const fixture: { session: Record<string, unknown>; messages: { id: string; sessionID: string }[];
          parts: { id: string; messageID: string }[] } = JSON.parse(await readFile(new URL(
          '../../../../../packages/plugins/kilo/src/agent/externalSessions/__fixtures__/kilo-json-1.0.25.json', import.meta.url), 'utf8'));
        await putKilo(transcriptPath, { ...fixture.session, time: { created: Date.now(), updated: Date.now() } });
        for (const message of fixture.messages) await putKilo(join(kiloRoot, 'message', message.sessionID, `${message.id}.json`), message);
        for (const part of fixture.parts) await putKilo(join(kiloRoot, 'part', part.messageID, `${part.id}.json`), part);
      } else {
        await writeFile(transcriptPath, header + row('first', null, 'quartz initial native message'));
      }
      if (isGemini) {
        const { gemini } = await import('../../../../../packages/plugins/gemini/src/agent/surfaces/sessions/external/__fixtures__/gemini064');
        await appendFile(transcriptPath, JSON.stringify({ ...gemini('native-tools', ''), toolCalls: [{
          id: 'call', name: 'shell', args: { command: 'topaz hidden tool input' }, status: 'success', timestamp,
          result: 'citrine native tool output',
        }] }) + '\n');
      }
      if (isQwen) {
        const { record, jsonl } = await import('../../../../../packages/plugins/qwen/src/agent/externalSessions/__fixtures__/qwen0253');
        await appendFile(transcriptPath, jsonl([
          record('native-tool-call', 'first', 'assistant', { sessionId: nativeSessionId,
            message: { role: 'model', parts: [{ functionCall: { id: 'call', name: 'shell', args: { command: 'topaz hidden tool input' } } }] } }),
          record('native-tool-result', 'native-tool-call', 'tool_result', { sessionId: nativeSessionId,
            message: { role: 'user', parts: [{ functionResponse: { id: 'call', name: 'shell', response: { output: 'citrine native tool output' } } }] } }),
        ]));
      }
      const { pluginReloadController } = await import('@/plugins/runtime/reload/singleton');
      const { createAdmittedPluginRuntimeFixture } = await import('@/plugins/testkit/admittedRuntime');
      const { createResolvedContributionRegistry } = await import('@/plugins/projection/registry/createResolvedContributionRegistry');
      const { resolveBuiltInContributions } = await import('@/plugins/projection/registry/resolveBuiltInContributions');
      let contributions = resolveBuiltInContributions();
      if (isDevin || isKimi || isKilo || isFx || isAuggie || isCopilot || isDroid || isCodeBuddy || isCursor || isGrok || isKiro || isGemini || isQwen) {
        // Consume the actual authored manifest through the canonical projector.
        // Program integration owns the once-per-batch generated publication.
        const { PLUGIN_MANIFEST } = isDevin ? await import('@happier-dev/plugins-devin/manifest')
          : isKimi ? await import('@happier-dev/plugins-kimi/manifest')
          : isGemini ? await import('@happier-dev/plugins-gemini/manifest')
          : isQwen ? await import('@happier-dev/plugins-qwen/manifest')
          : isCursor ? await import('@happier-dev/plugins-cursor/manifest')
          : isGrok ? await import('@happier-dev/plugins-grok/manifest')
          : isKiro ? await import('@happier-dev/plugins-kiro/manifest')
          : isCopilot ? await import('@happier-dev/plugins-copilot/manifest')
          : isDroid ? await import('@happier-dev/plugins-droid/manifest')
          : isCodeBuddy ? await import('@happier-dev/plugins-codebuddy/manifest')
          : isAuggie ? await import('@happier-dev/plugins-auggie/manifest')
          : isFx ? await import('@happier-dev/plugins-fx/manifest') : await import('@happier-dev/plugins-kilo/manifest');
        const { loadBundledPluginLocatorResult } = await import('@/plugins/projection/registry/builtIn/locators');
        const { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS } = await import('@/plugins/projection/registry/sources/generatedBundledPluginManifests');
        const { BUNDLED_FIRST_PARTY_AGENT_REGISTRATION_BINDINGS } = await import('@/plugins/projection/registry/sources/generatedBundledPlugins');
        const { projectLoadedPluginContributes } = await import('@/plugins/projection/registry/resolvePluginContributions');
        const { projectBuiltInAgents } = await import('@/plugins/projection/registry/builtIn/agents');
        const projected = projectLoadedPluginContributes({ provenance: 'first_party', loadResult: {
          loadedPlugins: loadBundledPluginLocatorResult(BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.map(locator =>
            locator.pluginId === pluginId ? { ...locator, manifest: PLUGIN_MANIFEST } : locator)).loadedPlugins,
          diagnosticsByPluginId: {},
        } });
        contributions = { ...contributions, ...projected, agents: projectBuiltInAgents({
          manifestAgents: projected.agents ?? [], registrationBindings: BUNDLED_FIRST_PARTY_AGENT_REGISTRATION_BINDINGS,
        }), providers: projected.providers ?? [] };
      }
      runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
        runtimeOptions: { contributes: createResolvedContributionRegistry(contributions), pluginIds: [pluginId] } });
      expect(runtime.registry.agentRuntimesByAgentId.get(agentId)?.externalSessions,
        JSON.stringify(runtime.registry.pluginDiagnosticsByPluginId[pluginId] ?? [])).toBeTruthy();
      if (isGemini || isQwen) {
        const reader = runtime.registry.agentRuntimesByAgentId.get(agentId)!.externalSessions!;
        const { EXTERNAL_SESSIONS_INVOCATION_POLICY } = await import('@/session/external/agentExternalSessionsInvocation');
        const source = { kind: isGemini ? 'geminiConfigDir' : 'qwenRuntimeDir' };
        const candidates = await reader.listCandidates({ source, ...EXTERNAL_SESSIONS_INVOCATION_POLICY.listCandidates,
          signal: new AbortController().signal });
        if (!candidates.ok) throw new Error(`Registered ${agentId} native inventory failed: ${JSON.stringify(candidates)}`);
        const initialPage = await reader.pageTranscript({ source, remoteSessionId: nativeSessionId, direction: 'older',
          ...EXTERNAL_SESSIONS_INVOCATION_POLICY.pageTranscript, signal: new AbortController().signal });
        if (!initialPage.ok) throw new Error(`Registered ${agentId} native page failed: ${JSON.stringify(initialPage)}`);
      }
      if (isKimi) {
        // An earlier browse consumer has its own tail. Enabling Memory later
        // must still ingest both that prefix and the subsequently appended row.
        const reader = runtime.registry.agentRuntimesByAgentId.get(agentId)!.externalSessions!;
        const source = { kind: 'kimiCodeHome' };
        const bounds = { source, signal: new AbortController().signal, maxItems: 1, maxSerializedBytes: 100_000 };
        const listed = await reader.listCandidates(bounds);
        if (!listed.ok) throw new Error(`Kimi warm discovery: ${listed.code}: ${listed.message ?? ''}`);
        expect(listed).toMatchObject({ ok: true, value: { candidates: [expect.anything()] } });
        expect(await reader.pageTranscript({ ...bounds, remoteSessionId: 'session_fixture', direction: 'older' }))
          .toMatchObject({ ok: true, value: { tailCursor: expect.any(String) } });
        await appendFile(transcriptPath, row('warm', 'first', 'jade before Memory enable'));
      }
      const { createExternalSessionObservationDaemonProjection } = await import('@/api/session/external/leases/createExternalSessionObservationDaemonProjection');
      observation = createExternalSessionObservationDaemonProjection({
        publishField: async () => { throw new Error('Transcript indexing must not fabricate a linked Session'); },
        watchFile: (path, onChange) => { fileChanges.set(path, onChange); return () => { fileChanges.delete(path); }; },
        watchTopologyDirectory: (path, onChange) => { topologyChanges.set(path, onChange); return () => { topologyChanges.delete(path); }; },
      });
      const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
      await writeMemorySettingsToDisk({ v: 1, enabled: true, indexMode: 'deep', backfillPolicy: 'all_history',
        coveragePolicy: { type: 'full' }, conversationSearch: { indexExternal: {
          enabled: true, agents: [agentId], historyDays: isCodex ? 1 : null, includeToolOutput: isFx,
        } } });
      const { startMemoryWorker } = await import('./memoryWorker');
      worker = await startMemoryWorker({ credentials: { token: 'fixture', encryption: null }, machineId: 'machine' });
      worker.attachExternalObservation!(observation);
      await worker.ensureUpToDate();
      const { openDeepIndexDb } = await import('./deepIndex/deepIndexDb');
      const search = (query: string) => {
        const db = openDeepIndexDb({ dbPath: worker!.getDeepDbPath()! });
        try { return db.search({ query, scope: { type: 'global' }, maxResults: 10, includeExternal: true, includeSessions: false }); }
        finally { db.close(); }
      };
      const readFrontier = () => {
        const db = openDeepIndexDb({ dbPath: worker!.getDeepDbPath()! });
        try { return db.listExternalSourceStates()[0]!; }
        finally { db.close(); }
      };
      expect(search('quartz'), JSON.stringify({ sources: worker.getIndexSources(), status: worker.getWorkerStatus(),
        observedTranscript: fileChanges.has(transcriptPath) })).toHaveLength(1);
      if (isCodex) expect(worker.getIndexSources!()).toContainEqual({
        source: { type: 'external_transcript', agentId: 'codex', sourceKey: 'codexHome:user:::' }, state: 'ready',
      });
      expect(search('garnet')).toEqual([]);
      if (isGemini || isQwen) {
        expect(search('topaz')).toEqual([]);
        expect(search('citrine')).toEqual([]);
      }
      const initialFrontier = readFrontier();
      // A retained tail makes the next tick consume readAfterTranscript rather
      // than rebuilding the initial page; this is the production frontier.
      expect(JSON.parse(initialFrontier.cursor!)).toMatchObject({ type: 'tail', cursor: expect.any(String) });
      // A successful initial inventory alone does not establish observation.
      expect(fileChanges.has(transcriptPath)).toBe(true);
      if (sidecarPath) expect(fileChanges.has(sidecarPath)).toBe(true);
      const notifyFile = fileChanges.get(transcriptPath)!;
      if (isDevin) {
        expect(fileChanges.has(transcriptPath + '-wal')).toBe(true);
        await rename(transcriptPath, transcriptPath + '.retained');
        notifyFile(transcriptPath);
        await expect(worker.ensureUpToDate()).rejects.toThrow('unavailable');
        expect(search('quartz')).toHaveLength(1);
        await rename(transcriptPath + '.retained', transcriptPath);
      }
      if (isAuggie) {
        // An interrupted native snapshot is unavailable, not authoritative
        // disappearance. Retain the prior projection until a valid read.
        await writeFile(transcriptPath, '{');
        notifyFile(transcriptPath);
        await expect(worker.ensureUpToDate()).rejects.toThrow('unsupported');
        expect(search('quartz')).toHaveLength(1);
      }
      const appendedPath = isKilo ? join(kiloRoot, 'part', 'msg_02', 'prt_05.json') : transcriptPath;
      if (isDevin) {
        devinFixture!.append('garnet appended native message');
        fileChanges.get(transcriptPath + '-wal')!(transcriptPath + '-wal');
      } else if (isAuggie) {
        await writeAuggie(['quartz initial native message', 'garnet appended native message']);
        notifyFile(transcriptPath);
      } else if (isKilo) {
        await putKilo(appendedPath, { id: 'prt_05', sessionID: 'ses_fixture', messageID: 'msg_02', type: 'text', text: 'garnet appended native message' });
        expect(topologyChanges.has(kiloRoot)).toBe(true);
        topologyChanges.get(kiloRoot)!(appendedPath);
      } else {
        await appendFile(transcriptPath, row('second', isQwen ? 'native-tool-result' : 'first', 'garnet appended native message'));
        notifyFile(transcriptPath);
      }
      await worker.ensureUpToDate();
      expect(search('garnet')).toHaveLength(1);
      expect(search('quartz')).toHaveLength(1);
      if (isKimi) expect(search('jade')).toHaveLength(1);
      expect(readFrontier().nextOrdinal).toBeGreaterThan(initialFrontier.nextOrdinal);
      if (isFx) {
        // A referenced result can change without any event-log append. The
        // incumbent observer invalidates the same reader's prefix witness.
        expect(search('olivine')).toHaveLength(1);
        expect(fileChanges.has(fxResultPath)).toBe(true);
        await writeFile(fxResultPath, 'citrine native output');
        fileChanges.get(fxResultPath)!(fxResultPath);
        await worker.ensureUpToDate();
        await worker.ensureUpToDate();
        expect(search('olivine')).toEqual([]);
        expect(search('citrine')).toHaveLength(1);
        expect(search('quartz')).toHaveLength(1);
        expect(search('garnet')).toHaveLength(1);
      }
      if (kimiFixture) {
        // An unavailable wire is not proof the native Session was deleted.
        const savedWire = await readFile(transcriptPath);
        await rm(transcriptPath);
        topologyChanges.get(join(directory, '.kimi-code'))!();
        await expect(worker.ensureUpToDate()).rejects.toThrow('unavailable');
        expect(search('quartz')).toHaveLength(1);
        expect(search('garnet')).toHaveLength(1);
        await writeFile(transcriptPath, savedWire);
        topologyChanges.get(join(directory, '.kimi-code'))!();
        await worker.ensureUpToDate();
        await worker.ensureUpToDate();
        await appendFile(transcriptPath, kimiFixture.kimiWire([{ type: 'context.undo', count: 1 }]));
        fileChanges.get(transcriptPath)!(transcriptPath);
        await worker.ensureUpToDate();
        await worker.ensureUpToDate();
        expect(search('garnet')).toEqual([]);
        expect(search('quartz')).toHaveLength(1);
        expect(search('jade')).toHaveLength(1);
      }
      if (isKilo) {
        // A settled part can change without a message/session timestamp update.
        await putKilo(appendedPath, { id: 'prt_05', sessionID: 'ses_fixture', messageID: 'msg_02', type: 'text', text: 'opal replacement native message' });
        expect(fileChanges.has(appendedPath)).toBe(true);
        fileChanges.get(appendedPath)!(appendedPath);
        await worker.ensureUpToDate();
        expect(search('garnet')).toEqual([]);
        // Replacement retires the old projection; the next worker turn
        // reads the current source again through the initial page boundary.
        await worker.ensureUpToDate();
        expect(search('opal')).toHaveLength(1);
        await putKilo(transcriptPath, { id: 'ses_fixture', projectID: 'project', directory: '/repo', title: 'Ordinary title',
          version: '1.0.25', time: { created: Date.now(), updated: Date.now() }, revert: { messageID: 'msg_02' } });
        fileChanges.get(transcriptPath)!(transcriptPath);
        await worker.ensureUpToDate();
        expect(search('opal')).toEqual([]);
        await worker.ensureUpToDate();
        expect(search('quartz')).toHaveLength(1);
      }
      if (isDevin || isKimi || isGemini || isQwen || isFx || isAuggie || isCopilot || isDroid || isCodeBuddy || isCursor || isGrok || isKiro) {
        if (isDevin) {
          devinFixture!.db.prepare('UPDATE message_nodes SET chat_message=? WHERE node_id=1').run(JSON.stringify({
            role: 'user', message_id: 'message-1', content: 'amethyst replacement message',
          }));
          devinFixture!.db.prepare('UPDATE sessions SET main_chain_id=1').run();
        } else if (isAuggie) await writeAuggie(['amethyst replacement message']);
        else await writeFile(transcriptPath, header + row(isFx ? 'first' : 'replacement', null, 'amethyst replacement message'));
        fileChanges.get(transcriptPath)!(transcriptPath);
        await worker.ensureUpToDate();
        await worker.ensureUpToDate();
        expect(search('quartz')).toEqual([]);
        expect(search('garnet')).toEqual([]);
        expect(search('amethyst')).toHaveLength(1);
        if (sidecarPath) {
          const metadata: Record<string, unknown> = JSON.parse(await readFile(sidecarPath, 'utf8'));
          await writeFile(sidecarPath, JSON.stringify({ ...metadata, ...(isGrok ? { generated_title: 'Renamed title' } : { title: 'Renamed title' }) }));
          fileChanges.get(sidecarPath)!(sidecarPath);
          await worker.ensureUpToDate();
          expect(search('amethyst')).toHaveLength(1);
        }
      }
      if (isDevin) {
        // An authoritative deletion inside a readable shared DB retires rows;
        // losing the whole DB above must retain them.
        devinFixture!.db.prepare('DELETE FROM message_nodes').run();
        devinFixture!.db.prepare('DELETE FROM sessions').run();
      } else if (isKimi) await rm(dirname(sidecarPath!), { recursive: true });
      else await rm(transcriptPath);
      fileChanges.get(transcriptPath)!(transcriptPath);
      await worker.ensureUpToDate();
      expect(search('garnet')).toEqual([]);
      expect(search('quartz')).toEqual([]);
      expect(search('amethyst')).toEqual([]);
      if (isFx) expect(search('citrine')).toEqual([]);
      const removedDb = openDeepIndexDb({ dbPath: worker.getDeepDbPath()! });
      try { expect(removedDb.listExternalSourceStates()).toEqual([]); }
      finally { removedDb.close(); }
      await worker.stop();
      expect(fileChanges.size).toBe(0);
      expect(topologyChanges.size).toBe(0);
    } finally {
      await worker?.stop();
      await observation?.dispose();
      await runtime?.dispose();
      devinFixture?.close();
      get.mockRestore();
      env.restore();
      vi.resetModules();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
