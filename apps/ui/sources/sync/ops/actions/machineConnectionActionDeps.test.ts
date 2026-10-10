import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createActionExecutor, computeHomeQrBindingProofV2, type ActionExecutorDeps } from '@happier-dev/protocol';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { encodeBase64 } from '@/encryption/base64';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

// Keep the actual Socket and Sync lifecycle; only external Engine.IO packets stay disconnected.
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

const boundary = vi.hoisted(() => ({ rpc: vi.fn() }));
// This native rendering package is outside the transport process and never renders here.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));
// Entropy is a genuine system boundary; this pins the request binding proof.
vi.mock('@/platform/cryptoRandom', () => ({ getRandomBytes: (size: number) => new Uint8Array(size).fill(7) }));
// Daemon RPC is the external terminal process boundary; Action admission and
// the canonical terminal request/response adapter remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: boundary.rpc }));
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
const { createMachineConnectionActionDeps } = await import('./machineConnectionActionDeps');
const makeExecutor = () => createActionExecutor({
    ...createMachineConnectionActionDeps(),
    // The terminal adapter does not own policy; compose the real host policy port.
    isActionApprovalRequired: (actionId, context, input) => isApprovalRequiredByActionsSettings(
        actionId, normalizeActionsSettingsV1(context.actionsSettings), context, undefined, undefined, input,
    ),
} satisfies Partial<ActionExecutorDeps> as unknown as ActionExecutorDeps);

describe('UI machine connection Actions', () => {
    beforeEach(async () => { await harness.reset(); boundary.rpc.mockReset(); });
    afterEach(() => standardCleanup());
    it('lists existing terminals on the requested Home and preserves method-unavailable fallback', async () => {
        const serverId = await harness.addHome({ name: 'Shell Home', serverUrl: 'https://shell.example', accountId: 'alice' });
        const signal = new AbortController().signal;
        boundary.rpc.mockResolvedValueOnce({ ok: true, terminals: [] });
        expect(await makeExecutor().execute('machines.terminal.list', { machineId: 'machine', serverId }, { surface: 'ui', authority: 'present_user', serverId, signal }))
            .toEqual({ ok: true, result: { ok: true, terminals: [] } });
        expect(boundary.rpc).toHaveBeenLastCalledWith(expect.objectContaining({ machineId: 'machine', serverId, signal, method: 'daemon.terminal.list', payload: {} }));
        boundary.rpc.mockRejectedValueOnce({ rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' });
        expect(await makeExecutor().execute('machines.terminal.list', { machineId: 'machine', serverId }, { surface: 'ui', authority: 'present_user', serverId }))
            .toEqual({ ok: true, result: null });
    });
    it('opens a terminal with a configured UI waiver on the requested Home and retains the daemon handle', async () => {
        const serverId = await harness.addHome({ name: 'Shell Home', serverUrl: 'https://shell.example', accountId: 'alice' });
        const signal = new AbortController().signal;
        boundary.rpc.mockResolvedValueOnce({ ok: true, terminalId: 'pty', reused: true });
        expect(await makeExecutor().execute('machines.terminal.open', { machineId: 'machine', serverId, terminalKey: 'shell', cwd: '/project' }, {
            surface: 'ui', authority: 'present_user', serverId, signal,
            actionsSettings: { v: 1, actions: {}, approvalWaivedSurfaces: { 'machines.terminal.open': ['ui'] } },
        })).toEqual({ ok: true, result: { ok: true, terminalId: 'pty', reused: true } });
        expect(boundary.rpc).toHaveBeenLastCalledWith(expect.objectContaining({ serverId, machineId: 'machine', signal,
            method: RPC_METHODS.DAEMON_TERMINAL_ENSURE, payload: { terminalKey: 'shell', cwd: '/project' } }));
    });
    it('rejects an invalid Home address through the canonical connection owner', async () => {
        const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://existing.example', accountId: 'alice' });
        expect(await makeExecutor().execute('homes.connect', { address: 'ftp://wrong.example' }, {
            surface: 'ui', authority: 'present_user', serverId,
        })).toEqual({ ok: true, result: { kind: 'invalid_address' } });
        expect(harness.requests.some((request) => request.serverUrl === 'ftp://wrong.example')).toBe(false);
    });
    it('reconnects the focused Home through the real connection lifecycle', async () => {
        await loadSyncSingletonForTests();
        const serverId = await harness.addHome({ name: 'Focused Home', serverUrl: 'https://focused.example', accountId: 'alice' });
        const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
        expect(getActiveServerAccountScope()).toBeNull();
        try {
            expect(await makeExecutor().execute('homes.reconnect', { serverId }, {
                surface: 'ui', authority: 'present_user', serverId,
            })).toEqual({ ok: true, result: { serverId } });
            expect(getActiveServerAccountScope()).toMatchObject({
                serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'alice',
            });
        } finally {
            const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
            await disconnectActiveServerConnection();
        }
    });
    it('refuses reconnecting an unfocused Home rather than retrying another Home', async () => {
        const other = await harness.addHome({ name: 'Other Home', serverUrl: 'https://other.example', accountId: 'alice' });
        await harness.addHome({ name: 'Focused Home', serverUrl: 'https://focused.example', accountId: 'alice' });
        const requestCount = harness.requests.length;
        expect(await makeExecutor().execute('homes.reconnect', { serverId: other }, {
            surface: 'ui', authority: 'present_user', serverId: other,
        })).toMatchObject({ ok: false, errorCode: 'home_not_focused' });
        expect(harness.requests).toHaveLength(requestCount);
    });
    it('does not retry using a replacement Account after the admitted Account retires', async () => {
        await loadSyncSingletonForTests();
        const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://focused.example', accountId: 'alice' });
        const { captureLazyActionAccountContext } = await import('./actionAccountContext');
        const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
        const account = await captureLazyActionAccountContext(serverId);
        try {
            await harness.switchAccount(serverId, 'bob');
            expect(account.accountLifetime.isCurrent()).toBe(false);
            const executor = createActionExecutor(createMachineConnectionActionDeps({ account }) as ActionExecutorDeps);
            const result = await executor.execute('homes.reconnect', { serverId }, {
                surface: 'ui', authority: 'present_user', serverId, runtimeAccountId: 'alice',
            });
            expect(result.ok).toBe(false);
            expect(getActiveServerAccountScope()).toBeNull();
        } finally {
            account.dispose();
            const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
            await disconnectActiveServerConnection();
        }
    });
    it('refuses reconnecting with a mismatched Action scope before touching transport', async () => {
        const other = await harness.addHome({ name: 'Other Home', serverUrl: 'https://other.example', accountId: 'alice' });
        const focused = await harness.addHome({ name: 'Focused Home', serverUrl: 'https://focused.example', accountId: 'alice' });
        const requestCount = harness.requests.length;
        expect(await makeExecutor().execute('homes.reconnect', { serverId: focused }, {
            surface: 'ui', authority: 'present_user', serverId: other,
        })).toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
        expect(harness.requests).toHaveLength(requestCount);
    });
    it('does not reconnect after caller cancellation', async () => {
        const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://focused.example', accountId: 'alice' });
        const controller = new AbortController();
        controller.abort();
        const requestCount = harness.requests.length;
        expect(await makeExecutor().execute('homes.reconnect', { serverId }, {
            surface: 'ui', authority: 'present_user', serverId, signal: controller.signal,
        })).toMatchObject({ ok: false, errorCode: 'cancelled' });
        expect(harness.requests).toHaveLength(requestCount);
    });
    it('prepares Windows SSH setup without exposing credentials or starting a native task', async () => {
        const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://setup.example', accountId: 'alice' });
        const result = await makeExecutor().execute('machines.add.command', {
            serverId, method: 'ssh', os: 'windows', host: 'ssh.example', port: 2222, username: 'alice', authMode: 'keyfile', identityFilePath: 'C:\\Keys\\ssh key',
        }, { surface: 'ui', authority: 'present_user', serverId });
        expect(result).toMatchObject({ ok: true, result: { descriptorFileRequired: false } });
        if (!result.ok || typeof result.result !== 'object' || result.result === null || !('command' in result.result)) throw new Error('No setup command');
        expect(result.result.command).toContain('happier machine setup');
        expect(result.result.command).toContain('--ssh-port 2222');
        expect(result.result.command).toContain('--home-url https://setup.example');
        expect(boundary.rpc).not.toHaveBeenCalled();
    });
    it('retires the trusted pairing lifecycle after returning its link when the Home Account changes', async () => {
        const identity = 'srv_pairing-home';
        const serverUrl = 'https://pairing.example';
        const serverId = await harness.addHome({ name: 'Pairing Home', serverUrl, serverIdentityId: identity, accountId: 'alice' });
        const descriptor = { v: 1 as const, homeServerIdentityId: identity, canonicalServerUrl: serverUrl, revision: 1,
            endpoints: [{ kind: 'https' as const, url: serverUrl }] };
        const { adoptHomeProfile } = await import('@/sync/domains/server/serverProfiles');
        await adoptHomeProfile({ descriptor, source: 'manual' });
        const features = { ...createRootLayoutFeaturesResponse({
            capabilities: { serverIdentity: { serverIdentityId: identity } },
            features: { auth: { pairing: { boundQrV2: { enabled: true }, desktopQrMobileScan: { enabled: false } } } } }), homeConnectionDescriptor: descriptor };
        const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features, serverIdentityId: identity } });
        harness.answer(serverId, '/v1/features', { body: features });
        harness.answer(serverId, '/v1/features/authenticated', { body: features });
        const expiresAtMs = Date.now() + 60_000;
        const expiresAt = new Date(expiresAtMs).toISOString();
        harness.answer(serverId, '/v1/auth/pairing/start', { body: { pairId: 'pair', expiresAt } });
        let releaseStatus!: () => void;
        const heldStatus = new Promise<void>((resolve) => { releaseStatus = resolve; });
        const requesterPublicKey = new Uint8Array(32).fill(9);
        const statusPath = '/v1/auth/pairing/status?pairId=pair';
        harness.answer(serverId, statusPath, { respondAfter: heldStatus, body: { state: 'requested', pairId: 'pair', expiresAt,
            requestedPublicKey: encodeBase64(requesterPublicKey), requestedDeviceLabel: 'Computer', homeServerIdentityId: identity,
            bindingProof: computeHomeQrBindingProofV2({ direction: 'trusted_home_displays', qrSecret: new Uint8Array(32).fill(7),
                pairId: 'pair', homeServerIdentityId: identity, requesterPublicKey, expiresAtMs }) } });
        harness.answer(serverId, '/v1/auth/pairing/consume', { body: {} });
        try {
            const result = await makeExecutor().execute('machines.pairing.create', { serverId }, { surface: 'ui', authority: 'present_user', serverId });
            if (!result.ok) throw new Error(JSON.stringify(result));
            expect(result).toMatchObject({ ok: true, result: { pairId: 'pair', expiresAtMs } });
            await vi.waitFor(() => expect(harness.requestsFor(statusPath)).toHaveLength(1));
            await harness.switchAccount(serverId, 'bob');
            await vi.waitFor(() => expect(harness.requestsFor('/v1/auth/pairing/consume')).toHaveLength(1));
            expect(harness.requestsFor('/v1/auth/pairing/consume')[0]?.input).toEqual({ pairId: 'pair', intent: 'cancel' });
            releaseStatus();
            await Promise.resolve();
            expect(harness.requests.some((request) => request.path.includes('response'))).toBe(false);
        } finally { releaseStatus(); }
    });
});
