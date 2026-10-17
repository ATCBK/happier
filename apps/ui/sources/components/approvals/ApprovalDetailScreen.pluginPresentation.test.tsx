import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { TargetActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { buildTargetActionApprovalArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { act } from 'react-test-renderer';
import type { Socket } from 'socket.io-client';

// Network, platform and navigation are boundaries; Artifact storage and presentation stay real.
installApprovalCommonModuleMocks();
const account = createProviderSettingsAccountHarness();
const { storage } = await import('@/sync/domains/state/storage');
const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
const replayBoundaries: ReturnType<typeof installDisconnectedServerSocketBoundary>[] = [];

it.each(['approve', 'reject'] as const)('routes plugin %s from the creator profile through this device profile for the same Home', async decision => {
    const outgoing: SocketRpcRequestPayload[] = [];
    const outgoingHomes: string[] = [];
    installDisconnectedServerSocketBoundary((socket, serverUrl) => {
        socket.connected = true;
        vi.spyOn(socket, 'timeout').mockReturnValue(socket);
        vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event: string, payload: SocketRpcRequestPayload) => {
            if (event === SOCKET_RPC_EVENTS.CALL) {
                outgoing.push(payload);
                outgoingHomes.push(new URL(serverUrl!).origin);
            }
            return { ok: true, result: { ok: true } };
        });
    });
    await account.restore({ serverIdentityId: 'srv_plugin_home', machines: [createMachineFixture({ id: 'machine-exact' })] });
    const request = TargetActionApprovalRequestV1Schema.parse({
        v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'cli' }, requestedSurface: 'cli',
        qualifiedActionId: 'acme.publisher/actions/releases/publish', input: { releaseTag: 'v1' }, secretInputPaths: [],
        sourceCustody: { kind: 'development', registeredRootId: 'plugin-root' },
        policyFingerprint: 'a'.repeat(64), subjectFingerprint: 'b'.repeat(64), summary: 'Publish release notes',
        replayPlacement: { serverId: 'cli-A', machineId: 'machine-exact' },
        executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
            serverId: 'cli-A', serverIdentityId: 'srv_plugin_home', accountId: 'account-a',
            machineId: 'machine-exact', actionId: 'action.invoke', requestId: 'plugin-approval-1' },
    });
    storage.getState().updateArtifact({ id: 'plugin-route', title: request.summary,
        header: buildTargetActionApprovalArtifactHeaderV1(request), body: JSON.stringify(request),
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1, isDecrypted: true });
    const { resolveApprovalReplayRoute } = await import('@/sync/ops/actions/defaultActionExecutor');
    expect(resolveApprovalReplayRoute(request)).toEqual({ serverId: account.serverId,
        serverIdentityId: 'srv_plugin_home', originServerId: 'cli-A' });
    const screen = await renderScreen(<ApprovalDetailScreen artifactId="plugin-route" />);
    expect(screen.findByTestId(`approvals.${decision}`)).not.toBeNull();
    expect(screen.findByTestId(`approvals.${decision}`)?.props.disabled).not.toBe(true);
    await screen.pressByTestIdAsync(`approvals.${decision}`);
    const { Modal } = await import('@/modal');
    expect(Modal.alert).not.toHaveBeenCalled();
    expect(outgoing).toEqual([expect.objectContaining({ method: `machine-exact:${RPC_METHODS.APPROVAL_REQUEST_DECIDE}`,
        params: { artifactId: 'plugin-route', decision,
            serverIdentityId: 'srv_plugin_home', originServerId: 'cli-A' } })]);
    expect(outgoingHomes).toEqual(['https://provider-settings-account.test']);
    // A portable identity unavailable on this device never falls back to creator-local routing.
    const wrongRequest = TargetActionApprovalRequestV1Schema.parse({ ...request,
        executionOriginV1: { ...request.executionOriginV1, serverIdentityId: 'srv_other_home' } });
    storage.getState().updateArtifact({ id: 'plugin-route-wrong-home', title: request.summary,
        header: buildTargetActionApprovalArtifactHeaderV1(wrongRequest), body: JSON.stringify(wrongRequest),
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1, isDecrypted: true });
    const wrongHome = await renderScreen(<ApprovalDetailScreen artifactId="plugin-route-wrong-home" />);
    expect(wrongHome.findByTestId(`approvals.${decision}`)).not.toBeNull();
    await wrongHome.pressByTestIdAsync(`approvals.${decision}`);
    expect(outgoing).toHaveLength(1);
});

afterEach(async () => {
    standardCleanup();
    await account.reset();
    for (const boundary of replayBoundaries.splice(0)) boundary.dispose();
    storage.setState(storage.getInitialState(), true);
    vi.clearAllMocks();
});

it.each(['approve', 'reject'] as const)('updates plugin %s routing when the matching Home arrives and retires without replacing the cached Artifact', async decision => {
    const outgoing: SocketRpcRequestPayload[] = [];
    const outgoingHomes: string[] = [];
    const configureSocket = (socket: Socket, serverUrl?: string) => {
        socket.connected = true;
        vi.spyOn(socket, 'timeout').mockReturnValue(socket);
        vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event: string, payload: SocketRpcRequestPayload) => {
            if (event === SOCKET_RPC_EVENTS.CALL) {
                outgoing.push(payload);
                outgoingHomes.push(new URL(serverUrl!).origin);
            }
            return { ok: true, result: { ok: true } };
        });
    };
    installDisconnectedServerSocketBoundary(configureSocket);
    await account.restore({ serverIdentityId: 'srv_artifact_home', machines: [createMachineFixture({ id: 'machine-exact' })] });
    const request = TargetActionApprovalRequestV1Schema.parse({
        v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'cli' }, requestedSurface: 'cli',
        qualifiedActionId: 'acme.publisher/actions/releases/publish', input: { releaseTag: 'v1' }, secretInputPaths: [],
        sourceCustody: { kind: 'development', registeredRootId: 'plugin-root' },
        policyFingerprint: 'a'.repeat(64), subjectFingerprint: 'b'.repeat(64), summary: 'Publish release notes',
        replayPlacement: { serverId: 'cli-A', machineId: 'machine-exact' },
        executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
            serverId: 'cli-A', serverIdentityId: 'srv_arriving_plugin_home', accountId: 'account-a',
            machineId: 'machine-exact', actionId: 'action.invoke', requestId: 'plugin-approval-recovery' },
    });
    const { captureActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const context = await captureActionAccountContext(account.serverId);
    let artifactId: string;
    try { artifactId = await context.createArtifact(buildTargetActionApprovalArtifactHeaderV1(request), JSON.stringify(request)); }
    finally { context.dispose(); }
    const { sync } = await import('@/sync/sync');
    const artifact = await sync.fetchArtifactWithBody(artifactId);
    expect(artifact).not.toBeNull();
    storage.getState().updateArtifact(artifact!);
    const cached = storage.getState().artifacts[artifactId];
    const screen = await renderScreen(<ApprovalDetailScreen artifactId={artifactId} />);
    await screen.pressByTestIdAsync(`approvals.${decision}`);
    const { Modal } = await import('@/modal');
    expect(Modal.alert).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('approval_origin_unavailable'));
    expect(outgoing).toEqual([]);
    vi.mocked(Modal.alert).mockClear();

    const profiles = await import('@/sync/domains/server/serverProfiles');
    let replayServerId = '';
    await act(async () => {
        replayServerId = await account.addHome({ serverUrl: 'https://plugin-approval-replay.test',
            name: 'Replay Home', accountId: 'account-a', serverIdentityId: 'srv_arriving_plugin_home', active: false });
        const home = account.home.findByServerUrl('https://plugin-approval-replay.test')!;
        replayBoundaries.push(installDisconnectedServerSocketBoundary(configureSocket, {
            serverUrl: home.serverUrl, token: home.token!,
        }));
        await account.publishMachines(replayServerId, [createMachineFixture({ id: 'machine-exact' })]);
    });
    expect(storage.getState().artifacts[artifactId]).toBe(cached);
    await vi.waitFor(() => {
        expect(screen.findByTestId(`approvals.${decision}`)).not.toBeNull();
        expect(screen.findByTestId(`approvals.${decision}`)?.props.disabled).not.toBe(true);
    });
    await screen.pressByTestIdAsync(`approvals.${decision}`);
    expect(Modal.alert).not.toHaveBeenCalled();
    expect(outgoing).toEqual([expect.objectContaining({ method: `machine-exact:${RPC_METHODS.APPROVAL_REQUEST_DECIDE}`,
        params: { artifactId, decision,
            serverIdentityId: 'srv_arriving_plugin_home', originServerId: 'cli-A' } })]);
    expect(outgoingHomes).toEqual(['https://plugin-approval-replay.test']);

    await act(async () => { await profiles.removeServerProfile(replayServerId); });
    expect(storage.getState().artifacts[artifactId]).toBe(cached);
    await screen.pressByTestIdAsync(`approvals.${decision}`);
    expect(outgoing).toHaveLength(1);
    expect(Modal.alert).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('approval_origin_unavailable'));
});

it('presents a plugin Action by its retained human summary without exposing routing ids as copy', async () => {
    await account.restore({ machines: [] });
    const request = TargetActionApprovalRequestV1Schema.parse({
        v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'cli' }, requestedSurface: 'cli',
        qualifiedActionId: 'qa.collection-detail/actions/set-complete',
        input: { completed: true }, secretInputPaths: [],
        sourceCustody: { kind: 'development', registeredRootId: 'private-root' },
        policyFingerprint: 'a'.repeat(64), subjectFingerprint: 'b'.repeat(64),
        summary: 'Change review completion',
    });
    storage.getState().updateArtifact({ id: 'presentation-review', title: request.summary,
        header: buildTargetActionApprovalArtifactHeaderV1(request), body: JSON.stringify(request),
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1, isDecrypted: true });
    const screen = await renderScreen(<ApprovalDetailScreen artifactId="presentation-review" />);
    const text = screen.getTextContent();
    expect(text).toContain('Change review completion');
    expect(text).toContain('true');
    for (const raw of ['qa.collection-detail', 'set-complete', 'development', 'private-root']) expect(text).not.toContain(raw);
    expect(screen.findByTestId('approvals.approve')?.props.disabled).toBe(false);
});
