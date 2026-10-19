import { describe, expect, it } from 'vitest';
import type { RpcHandlerContext, RpcHandlerMap, RpcHandlerRegistrar } from '@/api/rpc/types';
import { createMachineResourcesPolicyRuntime } from '@/daemon/resources/machineResourcesPolicy';
import { registerDaemonMachineResourcesPolicyRpcHandlers } from './daemonMachineResourcesPolicy';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { reloadConfiguration } from '@/configuration';
import { addServerProfile, adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

describe('machine resources policy custodian admission', () => {
  it('reads the local policy before the one pre-write current-admission round trip, but never writes after revocation', async () => {
    const identity = { serverId: 'home', machineId: 'machine', installationId: 'installation', custodianAccountId: 'owner' };
    let release!: (allowed: boolean) => void;
    const allowed = new Promise<boolean>(resolve => { release = resolve; });
    let first!: (stage: string) => void;
    const entered = new Promise<string>(resolve => { first = resolve; });
    let written = false;
    const policy = createMachineResourcesPolicyRuntime({ port: {
      read: async () => { first('local_read'); return { status: 'ready', metadata: {}, metadataVersion: 1 }; },
      compareAndSwap: async ({ metadata }) => { written = true; return { status: 'applied', metadata, metadataVersion: 2 }; },
    } });
    const handlers: RpcHandlerMap = new Map();
    registerDaemonMachineResourcesPolicyRpcHandlers({ registerHandler(method, handler) { handlers.set(method, handler); } }, { policy, target: () => identity });
    const pending = handlers.get(RPC_METHODS.MACHINES_RESOURCES_POLICY_SET)!({ machineId: 'machine', expectedRevision: 1,
      patch: { alerts: { cpu: { enabled: true } } } }, { signal: new AbortController().signal,
      machineAdmission: { ...identity, actorAccountId: 'owner', role: 'manage', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => { first('network_revalidation'); return allowed; } });
    try {
      expect(await entered).toBe('local_read');
      expect(written).toBe(false);
    } finally { release(false); await Promise.resolve(pending).catch(() => {}); policy.stop(); }
    expect(written).toBe(false);
  });
  it('saves custodian policies for a caller-local label of the admitted Home', async () => {
    const env = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    try {
      await withTempDir('happier-resources-home-', async home => {
        env.patch({ HAPPIER_HOME_DIR: home }); reloadConfiguration();
        const profile = await addServerProfile({ name: 'stack_resources__id_default', serverUrl: 'https://qa.example.test', webappUrl: 'https://qa.example.test' });
        const homeId = 'srv_resources_qa';
        await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: profile.id, observation: 'exact', descriptor: {
          v: 1, homeServerIdentityId: homeId, canonicalServerUrl: profile.serverUrl, revision: 1,
          endpoints: [{ kind: 'https', url: profile.serverUrl }],
        } });
        const identity = { serverId: profile.id, machineId: 'machine', installationId: 'installation', custodianAccountId: 'owner' };
        let metadata: Record<string, unknown> = {}; let revision = 1;
        const policy = createMachineResourcesPolicyRuntime({ port: {
          read: async () => ({ status: 'ready', metadata, metadataVersion: revision }),
          compareAndSwap: async input => { metadata = input.metadata; return { status: 'applied', metadata, metadataVersion: ++revision }; },
        } });
        const handlers: RpcHandlerMap = new Map();
        registerDaemonMachineResourcesPolicyRpcHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, { policy, target: () => identity });
        const set = handlers.get(RPC_METHODS.MACHINES_RESOURCES_POLICY_SET)!;
        const context: RpcHandlerContext = { signal: new AbortController().signal,
          machineAdmission: { ...identity, actorAccountId: 'owner', role: 'manage', encryptionMode: 'plain' },
          verifyMachineAdmissionCurrent: async () => true };
        const input = { serverId: 'browser-home', machineId: 'machine', expectedRevision: revision, patch: { alerts: { memory: { enabled: true } } } };
        try {
          await expect(set({ ...input, machineId: 'other-machine' }, context)).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
          await expect(set(input, { ...context, machineAdmission: { ...context.machineAdmission!, installationId: 'replaced' } })).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
          await expect(set(input, { ...context, machineAdmission: { ...context.machineAdmission!, actorAccountId: 'recipient' } })).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
          expect(await set(input, { ...context, verifyMachineAdmissionCurrent: async () => false })).toMatchObject({ status: 'unavailable' });
          expect(metadata).toEqual({});
          expect(await set(input, context)).toMatchObject({ status: 'applied', policy: { alerts: { memory: { enabled: true } } } });
          expect(await set({ ...input, expectedRevision: revision, patch: { processes: { allProcessesVisible: true } } }, context))
            .toMatchObject({ status: 'applied', policy: { processes: { allProcessesVisible: true }, alerts: { memory: { enabled: true } } } });
        } finally { policy.stop(); }
      });
    } finally { env.restore(); reloadConfiguration(); }
  });
  it('allows the custodian, refuses recipients and rechecks admission before a metadata write', async () => {
    const identity = { serverId: 'home', machineId: 'machine', installationId: 'installation', custodianAccountId: 'owner' };
    let writes = 0;
    let revoked = false;
    let revokeDuringRead = false;
    const runtime = createMachineResourcesPolicyRuntime({ port: {
      read: async () => { if (revokeDuringRead) revoked = true; return { status: 'ready', metadata: {}, metadataVersion: 1 }; },
      compareAndSwap: async ({ metadata }) => { writes++; return { status: 'applied', metadata, metadataVersion: 2 }; },
    } });
    // Match the canonical erased heterogeneous RPC transport registry.
    const handlers: RpcHandlerMap = new Map();
    const rpc: RpcHandlerRegistrar = { registerHandler(method, handler) { handlers.set(method, handler); } };
    registerDaemonMachineResourcesPolicyRpcHandlers(rpc, { policy: runtime, target: () => identity });
    const handler = handlers.get(RPC_METHODS.MACHINES_RESOURCES_POLICY_SET)!;
    const context = (actorAccountId: string): RpcHandlerContext => ({ signal: new AbortController().signal,
      machineAdmission: { machineId: identity.machineId, installationId: identity.installationId, custodianAccountId: 'owner', actorAccountId, role: 'manage', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => !revoked,
    });
    const input = { machineId: 'machine', expectedRevision: 1, patch: { alerts: { cpu: { enabled: true } } } };
    await expect(handler(input, context('recipient'))).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
    expect(writes).toBe(0);
    expect(await handler(input, context('owner'))).toMatchObject({ status: 'applied', revision: 2 });
    revokeDuringRead = true;
    expect(await handler(input, context('owner'))).toMatchObject({ status: 'unavailable' });
    expect(writes).toBe(1);
    runtime.stop();
  });
});
