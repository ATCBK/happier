import { once } from 'node:events';
import { createServer } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import { buildComposerReferenceMentionPayloadV1, HappierStructuredInputV1Schema, ProviderConnectionIdSchema } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SkillCatalogItemV1Schema } from '@happier-dev/protocol/runtime/catalog/skills';
import { ApiSessionClient } from './sessionClient';
import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { withTempDir } from '@/testkit/fs/tempDir';
import { ExecutionRunHostBridge } from '@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge';
import { prepareExecutionRunProviderLaunch } from '@/agent/runtime/bridges/executionRun/runtime/providerLaunch';
import { resolveStructuredInputProviderDispatchContext } from '@/agent/runtime/turns/resolveStructuredInputProviderContext';
import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import { resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import type { SessionRuntimeControls } from '@/rpc/handlers/sessionControls';
import * as persistence from '@/persistence';
import { ConnectedServiceRuntimeRegistry } from '@/daemon/connectedServices/runtimeRegistry/registry';
import { isExecutionRunConnectedServiceGenerationCurrent } from '@/daemon/connectedServices/runs/executionRunGenerationAdmission';
import { ConnectedServiceRunGenerationCurrentRequestSchema } from '@/daemon/connectedServices/runs/materializeContract';
import { parseConnectedServiceProjectionSnapshot } from '@/daemon/connectedServices/accountGroups/generation/connectedServiceProjectionSnapshot';
import { getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

type RunPorts = Pick<ConstructorParameters<typeof ExecutionRunHostBridge>[0],
  'sessionInteractionHost' | 'prepareManagedEndpoint' | 'resolveManagedPurposeBindingIntent' | 'resolveAccountSettingsSnapshot' | 'checkConnectedServicesGenerationCurrent'>;

// Observe the existing production composition hook. Registration, publication,
// Run preparation and structured-input resolution all remain real.
function createClient(directory: string, serverUrl: string) {
  let manager: ExecutionRunHostBridge | undefined;
  class ObservedSessionClient extends ApiSessionClient {
    override setExecutionRunWorkerUpdateSource(source: Parameters<ApiSessionClient['setExecutionRunWorkerUpdateSource']>[0]) {
      super.setExecutionRunWorkerUpdateSource(source);
      if (!(source instanceof ExecutionRunHostBridge)) throw new Error('Expected the real Run owner');
      manager = source;
    }
  }
  const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
  const socket = createApiSessionSocketStub();
  const client = new ObservedSessionClient(token, createPlainSessionFixture({ id: 'parent',
    metadata: createTestMetadata({ path: directory, machineId: 'machine' }) }), {
    metadataAuthority: { kind: 'owner', credentials: { token, encryption: null } },
    transport: { serverId: 'home', serverUrl,
      // Socket.IO is the genuine external transport boundary.
      createSessionSocketTransport: () => ({ socket: socket as never, transport: createSocketTransportAdapter(socket as never) }) },
  });
  if (!manager) throw new Error('Constructor did not register the Run owner');
  // Read the actual composed ports rather than constructing a second test host.
  const ports: RunPorts = {
    sessionInteractionHost: Reflect.get(manager, 'sessionInteractionHost'),
    prepareManagedEndpoint: Reflect.get(manager, 'prepareManagedEndpoint'),
    resolveManagedPurposeBindingIntent: Reflect.get(manager, 'resolveManagedPurposeBindingIntent'),
    resolveAccountSettingsSnapshot: Reflect.get(manager, 'resolveAccountSettingsSnapshot'),
    checkConnectedServicesGenerationCurrent: Reflect.get(manager, 'checkConnectedServicesGenerationCurrent'),
  };
  return { client, ports };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); resetInMemoryAccountSettingsContextForTests(); });

it('resolves Run composer inputs after constructor registration, rejects stale completions and withdraws retired callbacks', async () => {
  await withTempDir('c111-composer-', async directory => {
    const { client, ports } = createClient(directory, 'http://127.0.0.1:1');
    const host = ports.sessionInteractionHost!;
    const reference = { pluginId: 'acme.issues', localId: 'issues' };
    const signal = new AbortController().signal;
    const input = { reference, candidateId: '42', signal };
    const dispatch = () => resolveStructuredInputProviderDispatchContext({
      structuredInput: HappierStructuredInputV1Schema.parse({ v: 1, mentions: [{
        ...buildComposerReferenceMentionPayloadV1({ reference, candidate: { id: '42', label: 'Issue 42' } }),
        token: '@issue', start: 0, end: 6,
      }] }),
      composerReferences: host.resolveComposerReference ? { resolve: host.resolveComposerReference, signal } : undefined,
    });
    try {
      await expect(dispatch()).rejects.toMatchObject({ code: 'composer_reference_unavailable' });
      let finish!: (value: { id: string; label: string; context: string }) => void;
      const pendingResolution = new Promise<{ id: string; label: string; context: string }>(resolve => { finish = resolve; });
      client.setSessionRuntimeControls({ resolveComposerReference: async () => pendingResolution,
        readReferenceAction: async () => ({ generation: 'first' }), listSkills: async () => ({ skills: [] }),
        listVendorPlugins: async () => ({ vendorPlugins: [] }) });
      expect(host.resolveComposerReference).toBeTypeOf('function');
      const captured = host.resolveComposerReference!;
      const pending = captured(input);
      const skillDirectory = `${directory}/skills/review`;
      const skill = SkillCatalogItemV1Schema.parse({ name: 'review', path: `${skillDirectory}/SKILL.md`, origin: 'codex_native' });
      const next: SessionRuntimeControls = { resolveComposerReference: async () => ({ id: '42', label: 'Current issue', context: 'Current context' }),
        resolveComposerAttachmentForDispatch: async () => ({ attachments: [] }),
        readReferenceAction: async () => ({ generation: 'second' }), listSkills: async () => ({ skills: [skill] }),
        readSkillDelivery: () => ({ pluginRoot: directory, skillsRoot: `${directory}/skills`, nativeDisables: [],
          items: [{ name: 'review', skillId: 'library-review', digest: `sha256:${'a'.repeat(64)}`, directory: skillDirectory }] }),
        listVendorPlugins: async () => ({ vendorPlugins: [] }) };
      client.setSessionRuntimeControls(next);
      finish({ id: '42', label: 'Old issue', context: 'Old context' });
      await expect(pending).rejects.toMatchObject({ code: 'execution_run_interaction_unavailable' });
      await expect(captured(input)).rejects.toMatchObject({ code: 'execution_run_interaction_unavailable' });
      expect((await dispatch()).promptContext.references.composerReferences).toEqual([
        expect.objectContaining({ resolution: { id: '42', label: 'Current issue', context: 'Current context' } }),
      ]);
      await expect(host.readReferenceAction?.('workflow.definition.get', {})).resolves.toEqual({ generation: 'second' });
      await expect(host.listSkills?.()).resolves.toEqual({ skills: [skill] });
      await expect(host.listVendorPlugins?.()).resolves.toEqual({ vendorPlugins: [] });
      await expect(client.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.SESSION_SKILL_CATALOG_LIST, {}))
        .resolves.toMatchObject({ skills: [{ id: 'library-review', origin: 'happier', projectionRef: 'library-review' }] });
      const attachmentInput = { sessionId: 'parent', attachment: reference,
        request: { sessionId: 'parent', localId: 'input', attachments: [] }, signal };
      const attachment = host.resolveComposerAttachmentForDispatch!;
      await expect(attachment(attachmentInput)).resolves.toEqual({ attachments: [] });
      const retired = host.resolveComposerReference!;
      client.setSessionRuntimeControls(null);
      expect(host.resolveComposerReference).toBeUndefined();
      expect(host.readReferenceAction).toBeUndefined();
      expect(host.listSkills).toBeUndefined();
      expect(host.listVendorPlugins).toBeUndefined();
      expect(host.resolveComposerAttachmentForDispatch).toBeUndefined();
      await expect(retired(input)).rejects.toMatchObject({ code: 'execution_run_interaction_unavailable' });
      await expect(attachment(attachmentInput)).rejects.toMatchObject({ code: 'execution_run_interaction_unavailable' });
      await expect(client.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.SESSION_SKILL_CATALOG_LIST, {}))
        .resolves.toEqual({ unsupported: true, skills: [] });
    } finally { await client.close(); }
  });
});

it('opens a managed Gateway Run from its cold captured Account after registration and fences replacement/retirement', async () => {
  const fixture = await createManagedRunLaunchFixture({ physicalGateway: true });
  let resolveCount = 0;
  let opens = 0;
  let closes = 0;
  const home = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/account/encryption/currentness') response.end(JSON.stringify({ mode: 'plain', version: 1,
      settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
    else if (request.url === '/v2/account/settings') response.end(JSON.stringify({ version: 1, content: { t: 'plain', v: { schemaVersion: 6 } } }));
    else if (request.url === '/v1/account/entity-rows/provider-connections') response.end(JSON.stringify({ status: 'present', revision: 1,
      content: { t: 'plain', v: fixture.snapshot.providerConnectionsCatalog?.status === 'ready' ? fixture.snapshot.providerConnectionsCatalog.catalog : null } }));
    else if (request.url === '/v2/account/settings/history') response.end(JSON.stringify({ snapshots: [] }));
    else if (request.url === '/v1/responses') { request.resume(); request.on('end', () => response.end(JSON.stringify({ output_text: 'C111_GATEWAY_OK' }))); }
    else { response.statusCode = 404; response.end('{}'); }
  });
  home.listen(0, '127.0.0.1');
  await once(home, 'listening');
  const address = home.address();
  if (!address || typeof address === 'string') throw new Error('Missing Home boundary');
  const serverUrl = `http://127.0.0.1:${address.port}`;
  const { client, ports } = createClient(fixture.happyHomeDir, serverUrl);
  const signal = new AbortController().signal;
  let endpointUrl: string | undefined;
  const cleanups: Array<() => void | Promise<void>> = [];
  const services: NonNullable<SessionRuntimeControls['managedProviderRunServices']> = {
    // This is the daemon RPC boundary. Purpose policy and all Run owners remain real.
    resolvePurpose: async input => { resolveCount++; return { kind: 'provider_managed.purpose',
      binding: await fixture.gateway!.purposeBindingOwner.resolveBindingIntent(input) }; },
    openBinding: async () => { opens++; return { kind: 'provider_managed.binding', bindingId: `binding-${opens}`, endpointUrl: `${serverUrl}/v1`, headers: {} }; },
    readBinding: async input => ({ kind: 'provider_managed.binding', bindingId: input.bindingId, endpointUrl: `${serverUrl}/v1`, headers: {} }),
    closeBinding: async () => { closes++; },
  };
  // A different ambient Account must never supply this Session's catalog.
  setActiveAccountSettingsSnapshot(fixture.snapshot);
  const ambient = getActiveAccountSettingsSnapshot();
  const prepare = async () => {
    const snapshot = await ports.resolveAccountSettingsSnapshot!();
    const operation = ports.resolveAccountSettingsSnapshot?.readOperationContext?.();
    if (!operation) throw new Error('Expected the actual Session Account holder');
    return prepareExecutionRunProviderLaunch({
    selection: { agentTargetKey: fixture.agentTargetKey, providerConnectionId: ProviderConnectionIdSchema.parse('run-gateway'), modelId: 'example' },
    backendTarget: { kind: 'backend', backendId: fixture.agentId }, agentId: fixture.agentId,
    runId: 'attached-run', machineId: fixture.machineId, featureEnabled: true,
    happyHomeDir: fixture.happyHomeDir, accountSettingsSnapshot: snapshot, runtimeRegistryLease: fixture.lease,
    savedSecretOperationContext: operation,
    resolveManagedPurposeBindingIntent: ports.resolveManagedPurposeBindingIntent,
    prepareManagedEndpoint: ports.prepareManagedEndpoint ? async input => {
      const endpoint = await ports.prepareManagedEndpoint!({ ...input,
        agentId: fixture.agentId, executionRunOccurrenceId: 'attached-occurrence', signal, isCurrent: () => true });
      endpointUrl = endpoint.normalizedUrl;
      cleanups.push(endpoint.cleanup);
      return endpoint;
    } : undefined,
    });
  };
  try {
    await expect(prepare()).rejects.toBeDefined();
    expect(opens).toBe(0);
    client.setSessionRuntimeControls({ managedProviderRunServices: services });
    expect(ports.prepareManagedEndpoint).toBeTypeOf('function');
    expect(ports.resolveManagedPurposeBindingIntent).toBeTypeOf('function');
    const first = await prepare();
    expect(first.providerBinding?.connectionId).toBe('run-gateway');
    expect(ports.resolveAccountSettingsSnapshot?.readOperationContext?.()?.readSnapshot()?.providerConnectionsCatalog?.status).toBe('ready');
    expect(getActiveAccountSettingsSnapshot()).toBe(ambient);
    expect(resolveCount).toBeGreaterThan(0);
    expect(opens).toBe(1);
    const request = () => fetch(`${endpointUrl}/responses`, { method: 'POST',
      headers: { authorization: `Bearer ${first.environment.RUN_PROVIDER_TOKEN}` }, body: '{}' });
    expect(await (await request()).json()).toEqual({ output_text: 'C111_GATEWAY_OK' });
    client.setSessionRuntimeControls({ managedProviderRunServices: { ...services } });
    await expect(first.revalidateBeforeCommit()).resolves.toMatchObject({ ok: false });
    await first.cleanupOnExit?.();
    expect(closes).toBe(1);
    const second = await prepare();
    expect(opens).toBe(2);
    client.setSessionRuntimeControls(null);
    await expect(second.revalidateBeforeCommit()).resolves.toMatchObject({ ok: false });
    await second.cleanupOnExit?.();
    expect(closes).toBe(2);
    await expect(prepare()).rejects.toBeDefined();
    expect(opens).toBe(2);
    let enteredOpen!: () => void;
    let finishOpen!: () => void;
    const opening = new Promise<void>(resolve => { enteredOpen = resolve; });
    const release = new Promise<void>(resolve => { finishOpen = resolve; });
    client.setSessionRuntimeControls({ managedProviderRunServices: { ...services, openBinding: async input => {
      enteredOpen();
      await release;
      return await services.openBinding(input);
    } } });
    const staleOpening = prepare();
    await opening;
    client.setSessionRuntimeControls({ managedProviderRunServices: { ...services } });
    finishOpen();
    await expect(staleOpening).rejects.toBeDefined();
    expect(closes).toBe(3);
  } finally {
    await Promise.all(cleanups.map(cleanup => cleanup()));
    await client.close();
    home.closeAllConnections();
    await new Promise<void>((resolve, reject) => home.close(error => error ? reject(error) : resolve()));
    await fixture.cleanup();
  }
}, 30_000);

it('admits a brokered Team Run through the registered generation port without inventing a local credential generation', async () => {
  await withTempDir('c123-team-run-', async directory => {
    const registry = new ConnectedServiceRuntimeRegistry();
    const bindings = { v: 2, bindingsByServiceId: { 'happier.agent.codex/openai-codex': {
      source: 'team_resource', resourceId: 'team-resource', deliveryMode: 'brokered',
    } } } as const;
    const target = registry.registerRunTarget({ runKey: 'team-run', pid: process.pid, agentId: 'codex', sessionId: 'parent',
      materializationKey: 'team-run', connectedServicesBindingsRaw: bindings, connectedServiceSelectionsEnv: {} });
    expect(target.activeBindings).toEqual([]);
    const projection = parseConnectedServiceProjectionSnapshot({ connectedServicesV2: [], connectedServiceCredentialRevisionsV1: [] });
    const daemon = createServer((request, response) => {
      let body = '';
      request.on('data', data => { body += data; });
      request.on('end', () => {
        const input = ConnectedServiceRunGenerationCurrentRequestSchema.parse(JSON.parse(body));
        const current = registry.getRunTargetByRunKey(input.runId);
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ ok: true, current: Boolean(current && current.pid === input.runnerPid
          && isExecutionRunConnectedServiceGenerationCurrent({ runId: input.runId, target: current, projection })) }));
      });
    });
    daemon.listen(0, '127.0.0.1');
    await once(daemon, 'listening');
    const address = daemon.address();
    if (!address || typeof address === 'string') throw new Error('Missing daemon HTTP boundary');
    // The daemon-state filesystem read is a genuine OS boundary; the client,
    // registered Run port, HTTP contract, registry and generation policy stay real.
    vi.spyOn(persistence, 'readDaemonState').mockResolvedValue({ pid: process.pid, httpPort: address.port,
      startedAt: 1, startedWithCliVersion: '0.3.0', controlToken: 'fixture-daemon-control' });
    const { client, ports } = createClient(directory, 'http://127.0.0.1:1');
    const registration = { v: 1, activationId: 'a1234567-1234-4234-8234-123456789abc', runKey: 'team-run', agentId: 'codex',
      materializationKey: 'team-run', connectedServicesBindings: bindings, connectedServiceSelectionsEnv: {},
      sessionDirectory: directory, materializedRoot: null } as const;
    const check = () => ports.checkConnectedServicesGenerationCurrent!({ runId: 'team-run', registration });
    try {
      await expect(check()).resolves.toEqual({ current: true });
      registry.unregisterRunKey('team-run');
      await expect(check()).resolves.toEqual({ current: false });
    } finally {
      await client.close();
      daemon.closeAllConnections();
      await new Promise<void>((resolve, reject) => daemon.close(error => error ? reject(error) : resolve()));
    }
  });
});
