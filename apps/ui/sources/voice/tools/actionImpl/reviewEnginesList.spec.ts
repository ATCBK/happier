import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBackendTargetKey, PluginProjectionV2Schema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { AcpBackendDefinitionV1Schema } from '@happier-dev/protocol/acp/catalog/settingsV1';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { applyAcpCatalogSnapshot, resetAcpCatalogSnapshotsForTests } from '@/sync/store/settings/acpCatalogSnapshot';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { createMachineFixture, createPlainMachineRowFixture, createSessionFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import type { ExecutionRunsBackendSnapshotEntry } from '@/sync/domains/reviews/reviewEngineCatalog';

vi.mock('socket.io-client', async (importOriginal) => (
  await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));

type Backends = Readonly<Record<string, ExecutionRunsBackendSnapshotEntry>>;
let homes: Awaited<ReturnType<typeof serveAccountHomes>>;
let homeId = '';
let ownedHomeId = '';
let detachedHomeId = '';
let generation = 0;
let projection: ReturnType<typeof PluginProjectionV2Schema.parse> | null = null;
const backendsByTarget = new Map<string, Backends>();
const rpcRequests: { home: string; machineId: string; method: string }[] = [];

// Only the Socket.IO network ACK is replaced. Machine admission, scoped RPC,
// response parsing, capability caching and catalog projection all run for real.
installDisconnectedServerSocketBoundary((socket, serverUrl) => {
  socket.connected = true;
  vi.mocked(socket.connect).mockImplementation(() => {
    socket.connected = true;
    for (const listener of socket.listeners('connect')) listener();
    return socket;
  });
  vi.spyOn(socket.io, '_packet').mockImplementation(() => {});
  vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload) => {
    if (event !== 'rpc-call') throw new Error(`Unexpected review socket event: ${event}`);
    const home = Object.entries(homes.homes).find(([, value]) => value.serverUrl === serverUrl)?.[0];
    if (!home) throw new Error(`Unexpected review RPC Home: ${serverUrl}`);
    // Socket.IO exposes an untyped payload; the real shared RPC codec authored it.
    const request = payload as SocketRpcRequestPayload;
    const separator = request.method.indexOf(':');
    const machineId = request.method.slice(0, separator);
    const method = request.method.slice(separator + 1);
    rpcRequests.push({ home, machineId, method });
    if (method === RPC_METHODS.CAPABILITIES_DETECT) {
      const backends = backendsByTarget.get(`${homes.homes[home].id}:${machineId}`);
      if (!backends) throw new Error(`Unconfigured review detection: ${home}/${machineId}`);
      return { ok: true, result: { protocolVersion: 1, results: {
        'tool.executionRuns': { ok: true, checkedAt: 1, data: { backends } },
      } } };
    }
    if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
      return { ok: true, result: projection ? { protocolVersion: 1, projection } : { error: 'RPC_METHOD_NOT_FOUND' } };
    }
    throw new Error(`Unexpected review RPC method: ${method}`);
  });
});

const { storage, getStorage } = await import('@/sync/domains/state/storage');
const { prefetchMachineCapabilities, getMachineCapabilitiesSnapshot } = await import('@/hooks/server/useMachineCapabilitiesCache');
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { listReviewEnginesForVoiceTool } = await import('./reviewEnginesList');
const { t } = await import('@/text');

async function detect(backends: Backends, machineId = 'm1', serverId = homeId) {
  backendsByTarget.set(`${serverId}:${machineId}`, backends);
  await prefetchMachineCapabilities({ machineId, serverId, request: { requests: [{ id: 'tool.executionRuns' }] } });
  expect(getMachineCapabilitiesSnapshot(machineId, serverId)?.response.results['tool.executionRuns']?.ok).toBe(true);
}

function reviewDefinition(id: string, title = id) {
  return AcpBackendDefinitionV1Schema.parse({ id, name: id, title,
    launch: { kind: 'command', command: 'review', args: [] }, createdAt: 1, updatedAt: 1 });
}

function definitionTarget(id: string) {
  return resolveBackendTargetKeyV2({ kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId: id });
}

function readyCatalog(definitions: ReturnType<typeof reviewDefinition>[] = []) {
  const snapshot = { status: 'ready' as const, revision: 4, record: { v: 1 as const, definitions } };
  applyAcpCatalogSnapshot({ serverId: homeId, accountId: 'account-a' }, snapshot, true);
  return snapshot;
}

function createReviewProjection(narration = false) {
  return PluginProjectionV2Schema.parse({ v: 2, generation: 1, agentsById: {
    'plugin-review-bot': { id: 'plugin-review-bot', identity: { pluginId: 'acme.review', localId: 'review-bot' },
      settingsBackendId: 'plugin-review-bot', title: 'Review Bot Plugin', channel: 'plugin', isBuiltIn: false,
      providerOwnedEnvironmentKeys: [], ...(narration ? { capabilities: {
        executionRuns: { open: ['create'], checkpoint: false, stop: true }, structuredOutput: { formats: ['json'] },
      } } : {}),
    },
  } });
}

function setVisibleSession(serverId: string, sessionId = 's1') {
  getStorage().setState({
    sessionListRowsByServerId: { [serverId]: { [sessionId]: createSessionListRenderableSessionFixture({
      id: sessionId, updatedAt: 321, metadata: { machineId: 'lookup-machine', path: '/tmp/lookup', host: 'lookup.local' },
    }) } },
    ordinarySessionListMembershipByServerId: { [serverId]: [sessionId] },
    sessionListIndexByServerId: { [serverId]: [{ type: 'session', sessionId, serverId, serverName: 'Review Home' }] },
  });
}

describe('review engine voice tool', () => {
  beforeEach(async () => {
    projection = null;
    backendsByTarget.clear();
    rpcRequests.length = 0;
    generation += 1;
    homes = await serveAccountHomes({ homes: [
      { key: 'owned', serverUrl: `https://review-owned-${generation}.invalid`, accountId: 'account-a' },
      { key: 'detached', serverUrl: `https://review-detached-${generation}.invalid`, accountId: 'account-a' },
      { key: 'active', serverUrl: `https://review-active-${generation}.invalid`, accountId: 'account-a', currentAccount: true,
        settings: { backendEnabledByTargetKey: { [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'gemini' })]: false } } },
    ], route: request => {
      const machine = /^\/v1\/machines\/([^/]+)$/.exec(request.path);
      return machine ? Response.json({ machine: createPlainMachineRowFixture({ id: decodeURIComponent(machine[1]), accountId: 'account-a' }) }) : undefined;
    } });
    homeId = homes.homes.active.id;
    ownedHomeId = homes.homes.owned.id;
    detachedHomeId = homes.homes.detached.id;
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    getStorage().setState({ sessions: { s1: createSessionFixture({ id: 's1', serverId: homeId,
      active: true, metadata: { machineId: 'm1', path: '/workspace/review', host: 'review.local' } }) },
      machines: {}, machineListByServerId: {}, machineListStatusByServerId: {},
      sessionListRowsByServerId: {}, ordinarySessionListMembershipByServerId: {}, sessionListIndexByServerId: {},
      concurrentSessionListCacheByServerId: {},
    });
    resetAcpCatalogSnapshotsForTests();
    readyCatalog();
    clearDaemonMergedProjectionCacheForTests();
    await detect({ codex: { available: true, intents: ['review'] }, gemini: { available: false, intents: ['review'] },
      coderabbit: { available: true, intents: ['review'] } });
  });

  afterEach(async () => {
    const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
    await serverScopedRpcSocketPool.stopAll();
    await homes?.dispose();
    vi.unstubAllGlobals();
  });

  it('reads configured review engine labels from the row and refuses unavailable facts without a settings root', async () => {
    readyCatalog([reviewDefinition('row-review', 'Row review')]);
    await detect({ [definitionTarget('row-review')]: { available: true, intents: ['review'] } });
    expect(await listReviewEnginesForVoiceTool({ sessionId: 's1' })).toMatchObject({ items: expect.arrayContaining([
      expect.objectContaining({ engineId: definitionTarget('row-review'), label: 'Row review' }),
    ]) });
    applyAcpCatalogSnapshot({ serverId: homeId, accountId: 'account-a' }, { status: 'unavailable', reason: 'account-mode-mismatch' }, true);
    expect(await listReviewEnginesForVoiceTool({ sessionId: 's1' })).toMatchObject({ ok: false, errorCode: 'acp_catalog_unavailable' });
  });

  it('offers both ready configured definitions without exposing the abstract contribution', async () => {
    readyCatalog(['first', 'second'].map(id => reviewDefinition(id)));
    getStorage().setState({ sessions: { s1: createSessionFixture({ id: 's1', serverId: homeId,
      metadata: { machineId: 'uncached-machine', path: '/workspace/review', host: 'uncached.local' } }) } });
    expect(await listReviewEnginesForVoiceTool({ sessionId: 's1' })).toMatchObject({ items: expect.arrayContaining([
      expect.objectContaining({ engineId: definitionTarget('first') }), expect.objectContaining({ engineId: definitionTarget('second') }),
    ]) });
    const result = await listReviewEnginesForVoiceTool({ sessionId: 's1' }) as { items: { engineId: string }[] };
    expect(result.items.map(item => item.engineId)).not.toContain('custom-acp');
  });

  it('filters disabled review engines by default', async () => {
    const result = await listReviewEnginesForVoiceTool({ sessionId: 's1' }) as { items: { engineId: string }[] };
    expect(result.items.map(item => item.engineId)).toEqual(expect.arrayContaining(['codex', 'coderabbit']));
    expect(result.items.map(item => item.engineId)).not.toContain('gemini');
  });

  it('omits engines without exact-path support for a path-scoped review', async () => {
    await detect({ codex: { available: true, intents: ['review'], reviewScopes: ['worktree', 'paths'] },
      coderabbit: { available: true, intents: ['review'], reviewScopes: ['worktree'] } });
    expect(await listReviewEnginesForVoiceTool({ sessionId: 's1', scope: 'paths' })).toEqual({ sessionId: 's1', items: [
      { engineId: 'codex', label: t('agentInput.agent.codex'), enabled: true, capabilities: { structuredNarration: false } },
    ] });
  });

  it('offers a configured ACP review engine by its exact target key', async () => {
    readyCatalog([reviewDefinition('review-bot', 'Review Bot')]);
    await detect({ 'backend:review-bot:configured:review-bot': { available: true, intents: ['review'], title: 'Review Bot' } });
    const result = await listReviewEnginesForVoiceTool({ sessionId: 's1' }) as { items: { label: string }[] };
    expect(result.items).toContainEqual({ engineId: definitionTarget('review-bot'), label: 'Review Bot', enabled: true,
      capabilities: { structuredNarration: false } });
    expect(result.items.filter(item => item.label === 'Review Bot')).toHaveLength(1);
  });

  it('says which engines can narrate a walkthrough from the current Agent declaration, never from the engine id', async () => {
    projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, agentsById: { codex: {
      id: 'codex', identity: { pluginId: 'happier.agent.codex', localId: 'codex' }, isBuiltIn: true,
      capabilities: { executionRuns: { open: ['create'], checkpoint: false, stop: true }, structuredOutput: { formats: ['json'] } },
    } } });
    const result = await listReviewEnginesForVoiceTool({ sessionId: 's1', includeDisabled: true }) as {
      items: { engineId: string; capabilities: { structuredNarration: boolean } }[];
    };
    expect(result.items.find(item => item.engineId === 'codex')?.capabilities).toEqual({ structuredNarration: true });
    expect(result.items.every(item => typeof item.capabilities.structuredNarration === 'boolean')).toBe(true);
  });

  it('does not infer narration from a bundled engine id when its current declaration is unavailable', async () => {
    expect(await listReviewEnginesForVoiceTool({ sessionId: 's1' })).toMatchObject({ items: expect.arrayContaining([
      expect.objectContaining({ engineId: 'codex', capabilities: { structuredNarration: false } }),
    ]) });
  });

  it('uses the resolved backend catalog title for built-in review engine labels', async () => {
    expect(await listReviewEnginesForVoiceTool({ sessionId: 's1', includeDisabled: true })).toMatchObject({ items: expect.arrayContaining([
      expect.objectContaining({ engineId: 'codex', label: t('agentInput.agent.codex') }),
    ]) });
  });

  it('uses daemon merged projection titles for discovered/plugin review engine labels', async () => {
    await detect({ 'plugin-review-bot': { available: true, intents: ['review'] } });
    projection = createReviewProjection(true);
    expect(await listReviewEnginesForVoiceTool({ sessionId: 's1', includeDisabled: true })).toMatchObject({ items: expect.arrayContaining([
      { engineId: 'plugin-review-bot', label: 'Review Bot Plugin', enabled: true, capabilities: { structuredNarration: true } },
    ]) });
  });

  it('uses canonical backend keys when evaluating enabled state for discovered plugin review engines', async () => {
    await detect({ 'plugin-review-bot': { available: true, intents: ['review'] } });
    storage.getState().applySettingsForScope({ serverId: homeId, accountId: 'account-a' }, {
      ...storage.getState().settings, backendEnabledByTargetKey: { 'agent:acme.review/review-bot': false },
    }, 2);
    projection = createReviewProjection();
    expect(await listReviewEnginesForVoiceTool({ sessionId: 's1', includeDisabled: true })).toMatchObject({ items: expect.arrayContaining([
      expect.objectContaining({ engineId: 'plugin-review-bot', enabled: false }),
    ]) });
    expect(await listReviewEnginesForVoiceTool({ sessionId: 's1' })).toMatchObject({ items: expect.not.arrayContaining([
      expect.objectContaining({ engineId: 'plugin-review-bot' }),
    ]) });
  });

  it('includes disabled review engines when explicitly requested', async () => {
    expect(await listReviewEnginesForVoiceTool({ sessionId: 's1', includeDisabled: true })).toMatchObject({ items: expect.arrayContaining([
      expect.objectContaining({ engineId: 'gemini', enabled: false }),
    ]) });
  });

  it('prefers visible lookup session metadata over stale raw session metadata when resolving review engines', async () => {
    getStorage().setState({ sessions: { s1: createSessionFixture({ id: 's1', serverId: homeId,
      metadata: { machineId: 'raw-machine', path: '/workspace/stale', host: 'raw.local' } }) } });
    setVisibleSession(homeId);
    await detect({ codex: { available: false, intents: ['review'] }, coderabbit: { available: true, intents: ['review'] } }, 'lookup-machine');
    const result = await listReviewEnginesForVoiceTool({ sessionId: 's1' }) as { items: { engineId: string }[] };
    expect(result.items.map(item => item.engineId)).toContain('coderabbit');
    expect(result.items.map(item => item.engineId)).not.toContain('codex');
  });

  it('loads review engine capabilities from the resolved session machine target before visible metadata', async () => {
    const old = createMachineFixture({ id: 'm-old', active: false, activeAt: 1, replacedByMachineId: 'm-target', replacedAt: 2 });
    const target = createMachineFixture({ id: 'm-target', active: true, activeAt: 3 });
    getStorage().setState({ sessions: { s1: createSessionFixture({ id: 's1', serverId: homeId, active: false,
      metadata: { machineId: 'm-old', path: '/workspace/stale-repo', host: 'tester.local' } }) },
      machines: { 'm-old': old, 'm-target': target }, machineListByServerId: { [homeId]: [old, target] },
    });
    setVisibleSession(homeId);
    await detect({ codex: { available: false, intents: ['review'] } }, 'lookup-machine');
    await detect({ codex: { available: true, intents: ['review'] } }, 'm-target');
    expect(await listReviewEnginesForVoiceTool({ sessionId: 's1' })).toMatchObject({ items: expect.arrayContaining([
      expect.objectContaining({ engineId: 'codex', enabled: true }),
    ]) });
  });

  it('uses the owning server of the target session instead of the active server when resolving review engines', async () => {
    getStorage().setState({ sessions: { s_owned: createSessionFixture({ id: 's_owned', serverId: ownedHomeId,
      metadata: { machineId: 'raw-machine', path: '/workspace/stale', host: 'raw.local' } }) } });
    setVisibleSession(ownedHomeId, 's_owned');
    await detect({ codex: { available: false, intents: ['review'] } }, 'lookup-machine', homeId);
    await detect({ codex: { available: true, intents: ['review'], reviewScopes: ['paths'] } }, 'lookup-machine', ownedHomeId);
    expect(await listReviewEnginesForVoiceTool({ sessionId: 's_owned', serverId: ownedHomeId, scope: 'paths',
      acpCatalogSnapshot: readyCatalog(), backendEnabledByTargetKey: storage.getState().settings.backendEnabledByTargetKey,
    })).toEqual({ sessionId: 's_owned', items: [
      { engineId: 'codex', label: t('agentInput.agent.codex'), enabled: true, capabilities: { structuredNarration: false } },
    ] });
    expect(rpcRequests.filter(request => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE))
      .toEqual([{ home: 'owned', machineId: 'lookup-machine', method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE }]);
  });

  it('uses the captured Machine and Home for detached review discovery', async () => {
    await detect({ codex: { available: true, intents: ['review'], reviewScopes: ['paths'] } }, 'machine-detached', detachedHomeId);
    expect(await listReviewEnginesForVoiceTool({ sessionId: null, machineId: 'machine-detached', serverId: detachedHomeId,
      scope: 'paths', acpCatalogSnapshot: readyCatalog(), backendEnabledByTargetKey: storage.getState().settings.backendEnabledByTargetKey,
    })).toEqual({ sessionId: null, items: [
      { engineId: 'codex', label: t('agentInput.agent.codex'), enabled: true, capabilities: { structuredNarration: false } },
    ] });
    expect(rpcRequests.filter(request => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE))
      .toEqual([{ home: 'detached', machineId: 'machine-detached', method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE }]);
  });

  it('refuses detached review discovery without its Machine or Home instead of using active context', async () => {
    rpcRequests.length = 0;
    expect(await listReviewEnginesForVoiceTool({ sessionId: null, serverId: detachedHomeId }))
      .toMatchObject({ ok: false, errorCode: 'machine_not_selected' });
    expect(await listReviewEnginesForVoiceTool({ sessionId: null, machineId: 'machine-detached' }))
      .toMatchObject({ ok: false, errorCode: 'server_not_selected' });
    expect(rpcRequests).toEqual([]);
  });
});
