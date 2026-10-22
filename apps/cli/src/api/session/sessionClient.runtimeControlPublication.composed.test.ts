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

type RunPorts = Pick<ConstructorParameters<typeof ExecutionRunHostBridge>[0],
  'sessionInteractionHost' | 'prepareManagedEndpoint' | 'resolveManagedPurposeBindingIntent'>;

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
  };
  return { client, ports };
}

afterEach(() => { vi.unstubAllEnvs(); resetInMemoryAccountSettingsContextForTests(); });

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

it('opens a managed Gateway Run through services installed after registration and fences replacement/retirement', async () => {
  const fixture = await createManagedRunLaunchFixture({ physicalGateway: true });
  let resolveCount = 0;
  let opens = 0;
  let closes = 0;
  const home = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/account/encryption/currentness') response.end(JSON.stringify({ mode: 'plain', version: 1,
      settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
    else if (request.url === '/v2/account/settings') response.end(JSON.stringify({ version: 1, content: { t: 'plain', v: { schemaVersion: 6 } } }));
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
  const prepare = () => prepareExecutionRunProviderLaunch({
    selection: { agentTargetKey: fixture.agentTargetKey, providerConnectionId: ProviderConnectionIdSchema.parse('run-gateway'), modelId: 'example' },
    backendTarget: { kind: 'backend', backendId: fixture.agentId }, agentId: fixture.agentId,
    runId: 'attached-run', machineId: fixture.machineId, featureEnabled: true,
    happyHomeDir: fixture.happyHomeDir, accountSettingsSnapshot: fixture.snapshot, runtimeRegistryLease: fixture.lease,
    resolveManagedPurposeBindingIntent: ports.resolveManagedPurposeBindingIntent,
    prepareManagedEndpoint: ports.prepareManagedEndpoint ? async input => {
      const endpoint = await ports.prepareManagedEndpoint!({ ...input,
        agentId: fixture.agentId, executionRunOccurrenceId: 'attached-occurrence', signal, isCurrent: () => true });
      endpointUrl = endpoint.normalizedUrl;
      cleanups.push(endpoint.cleanup);
      return endpoint;
    } : undefined,
  });
  try {
    await expect(prepare()).rejects.toBeDefined();
    expect(opens).toBe(0);
    client.setSessionRuntimeControls({ managedProviderRunServices: services });
    expect(ports.prepareManagedEndpoint).toBeTypeOf('function');
    expect(ports.resolveManagedPurposeBindingIntent).toBeTypeOf('function');
    const first = await prepare();
    expect(first.providerBinding?.connectionId).toBe('run-gateway');
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
