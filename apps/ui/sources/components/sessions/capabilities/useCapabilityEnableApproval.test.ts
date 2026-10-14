import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { ApprovalRequestSchema, SessionCurrentProjectionRecordV1Schema, buildApprovalRequestArtifactHeaderV1, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createSessionOwnerMetadataV1, createPlainSessionOwnerMetadataEnvelopeV1, projectSessionOwnerCompatibilityViewV1, SessionMetadataOwnerPatchV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { McpServerCatalogV1Schema, McpServerCatalogRowMutationV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { resolveReachV1 } from '@happier-dev/protocol/reach/resolveReachV1';
import { SessionCapabilitiesSetOutputV1Schema } from '@happier-dev/protocol/actions/specs/sessionCapabilities';
import type { ApprovalRequest } from '@happier-dev/protocol';
import { readPendingCapabilityApplyV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const machineTransport = vi.hoisted(() => vi.fn<(request: { method: string; payload: unknown }) => Promise<unknown>>());
// The daemon network hop is external. Its replay runs the real Protocol owner,
// P2 metadata ports, strict approval producer and Artifact CAS beneath it.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineTransport }));
installApprovalCommonModuleMocks({ storage: original => original(), text: async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    const { sessionCapabilityTranslations } = await import('@/text/translations/sessionCapabilityTranslations');
    return createTextModuleMock({ translate: (key, params) => {
        const text = sessionCapabilityTranslations.en;
        if (key === 'capabilities.session.alwaysFor') return text.alwaysFor(params as { agent: string; place: string });
        if (key === 'capabilities.session.always') return text.always(params as { place: string });
        if (key === 'capabilities.session.wants') return text.wants(params as { agent: string; item: string });
        return key;
    } });
} });
await loadSyncSingletonForTests();
const { createDefaultActionExecutor, isApprovalExecutionOriginCurrentForAccountContext } = await import('@/sync/ops/actions/defaultActionExecutor');
const { useCapabilityEnableApproval } = await import('./useCapabilityEnableApproval');
const { getMcpServerCatalogSnapshot } = await import('@/sync/store/settings/mcpServerCatalogSnapshot');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { createUiSessionCapabilityActionDeps } = await import('@/sync/ops/actions/sessionCapabilityActionDeps');
const { readSessionCapabilityApplyChange, sessionCapabilityApplyNotice } = await import('./sessionCapabilityApplyNotice');

beforeEach(async () => { await homes.reset(); await loadSyncSingletonForTests(); machineTransport.mockReset(); });
afterEach(async () => { standardCleanup(); await homes.reset(); });

it.each(['always', 'reject', 'cannot_resume'] as const)('uses the existing Agent approval with reason and a D33-qualified %s decision', async choice => {
    const accountId = 'capability-owner';
    const serverId = await homes.addHome({ name: 'Capability Home', serverUrl: 'https://capability-approval.test', accountId,
        serverIdentityId: 'srv_capability-home-identity' });
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    homes.answer(serverId, '/v1/machines?includeRevoked=true', { body: [createPlainMachineRowFixture({ id: 'machine', accountId })] });
    const sessionId = 'c123456789012345678901234';
    const metadata = { path: '/repo', host: 'MacBook', machineId: 'machine', flavor: 'gemini', startedBy: 'daemon',
        runtimeDescriptorV1: { v: 1, agentId: 'gemini', agent: {} },
        agentRuntimeCapabilitiesV1: { capabilitySelection: { vendorResume: choice === 'cannot_resume' ? 'unsupported' : 'supported', skillsLiveReload: 'unsupported' } } };
    const owner = createSessionOwnerMetadataV1({ metadata });
    if (!owner.ok) throw new Error('Invalid Session owner fixture');
    let row = SessionCurrentProjectionRecordV1Schema.parse({ id: sessionId, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
        encryptionMode: 'plain', metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }), metadataVersion: 1,
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata), agentState: null, agentStateVersion: 1,
        dataEncryptionKey: null, share: null, responsibleAccountId: null, responsibleAccount: null,
        effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionAccessFixture().capabilities } });
    for (const suffix of ['', '?accessProjectionVersion=1']) homes.answer(serverId, `GET /v2/sessions/${sessionId}${suffix}`, { select: () => ({ body: { session: row } }) });
    homes.answer(serverId, `PATCH /v2/sessions/${sessionId}`, { select: input => {
        const patch = SessionMetadataOwnerPatchV1Schema.parse(input);
        expect(patch.sharedMetadata.expectedVersion).toBe(row.metadataVersion);
        row = { ...row, ownerMetadata: patch.ownerMetadata, metadata: patch.sharedMetadata.ciphertext, metadataVersion: row.metadataVersion + 1,
            agentState: patch.agentState.ciphertext, agentStateVersion: row.agentStateVersion! + 1 };
        return { body: { success: true, metadataLayoutVersion: 1, sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } } };
    } });
    let catalog = McpServerCatalogV1Schema.parse({ v: 1, servers: [{ id: 'linear-id', name: 'linear', title: 'Linear', transport: 'http',
        remote: { url: 'https://linear.test/mcp', headers: {} }, env: {}, createdAt: 1, updatedAt: 1 }],
        bindings: [{ id: 'general', serverId: 'linear-id', target: { t: 'project', projectKey: 'happier' }, enabled: true, createdAt: 1, updatedAt: 1 },
            { id: 'except-gemini', serverId: 'linear-id', target: { t: 'project', projectKey: 'happier' }, agentId: 'gemini', enabled: false, createdAt: 1, updatedAt: 1 }] });
    let revision = 1;
    homes.answer(serverId, 'GET /v1/account/entity-rows/mcp', { select: () => ({ body: { status: 'present', revision, content: { t: 'plain', v: catalog } } }) });
    homes.answer(serverId, 'POST /v1/account/entity-rows/mcp', { select: input => {
        const mutation = McpServerCatalogRowMutationV1Schema.parse(input);
        if (mutation.expectedRevision !== revision) return { body: { status: 'conflict', revision } };
        if (mutation.content?.t !== 'plain') throw new Error('Expected Plain Account catalog');
        catalog = mutation.content.v;
        return { body: { status: 'updated', revision: ++revision, cursor: revision } };
    } });
    homes.answer(serverId, '/v2/account/settings/history', { body: { snapshots: [] } });
    machineTransport.mockImplementation(async request => {
        expect(request.method).toBe(RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED);
        const account = await captureLazyActionAccountContext(serverId);
        try {
            const replay = createActionExecutor(createActionExecutorBoundaryFixture({ ...createUiSessionCapabilityActionDeps(account),
                // This unsigned host-origin fixture uses the same captured Home/Account
                // currentness owner as the real UI executor; no signed-origin branch is replaced.
                isApprovalExecutionOriginCurrent: async ({ origin }) => {
                    account.assertCurrent();
                    return isApprovalExecutionOriginCurrentForAccountContext({ origin,
                        accountServerId: account.serverId, accountId: account.accountId });
                },
                approvalsGet: async ({ artifactId }) => ApprovalRequestSchema.parse(JSON.parse(homes.artifacts(serverId).readPlainBody(artifactId)!)),
                approvalsUpdate: async ({ artifactId, request: next }) => {
                    const current = homes.artifacts(serverId).read(artifactId);
                    if (!current) return { ok: false, errorCode: 'approval_not_found', error: 'approval_not_found' };
                    const response = await homes.artifacts(serverId).handle(`/v1/artifacts/${artifactId}`, { method: 'POST', body: JSON.stringify({
                        header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(next)), expectedHeaderVersion: current.headerVersion,
                        body: encodePlainArtifactStoredContent({ body: JSON.stringify(next) }), expectedBodyVersion: current.bodyVersion,
                    }) });
                    return response?.ok ? { ok: true } : { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
                },
            }));
            const payload = request.payload;
            if (!payload || typeof payload !== 'object' || !('artifactId' in payload) || typeof payload.artifactId !== 'string') {
                throw new Error('Invalid approved replay transport');
            }
            return replay.replayApprovedApprovalRequest({ artifactId: payload.artifactId });
        } finally { account.dispose(); }
    });
    const executor = createDefaultActionExecutor();
    const requested = { sessionId, kind: 'mcp_server', id: 'linear-id', state: 'on', reason: 'Read the project issues' };
    const proposal = await executor.execute('session.capabilities.set', requested, { serverId, surface: 'agent', authority: 'account_automation',
        actionCaller: { kind: 'host' }, defaultSessionId: sessionId, actionRequestId: 'enable-linear',
        defaultSessionMachineId: 'machine', serverIdentityId: 'srv_capability-home-identity' });
    expect(proposal).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(row.metadataVersion).toBe(1);
    const artifact = homes.artifacts(serverId).list()[0];
    if (!artifact) throw new Error('Existing approval machinery did not persist the request');
    const approval = ApprovalRequestSchema.parse(JSON.parse(homes.artifacts(serverId).readPlainBody(artifact.id)!));
    expect(approval.actionArgs).toEqual(requested);
    const context = { machineId: 'machine', machinePlatform: 'posix', projectKey: 'happier', directory: '/repo', agentId: 'gemini' } as const;
    const rules = catalog.bindings.map(({ serverId: _id, ...rule }) => rule);
    const decision = resolveReachV1(rules, context);
    expect(decision).toMatchObject({ enabled: false, decidedBy: { ruleId: 'except-gemini', agentQualified: true } });
    const hook = await renderHook((current: ApprovalRequest) => useCapabilityEnableApproval({ artifact: { id: artifact.id,
        header: { kind: 'approval_request.v1', title: null, serverId } }, approval: current, sessionId, decidedBy: decision.decidedBy,
        projectKey: 'happier', machineId: 'machine', itemTitle: 'Linear', agentName: 'Gemini',
        names: { agentName: () => 'Gemini', projectName: key => key, machineName: () => 'MacBook', folderLabel: () => '~/repo' } }), { initialProps: approval });
    await vi.waitFor(() => expect(hook.getCurrent().alwaysWrite, JSON.stringify({ request: hook.getCurrent().request,
        ready: hook.getCurrent().ready, home: hook.getCurrent().serverId, resolution: hook.getCurrent().resolution,
        origin: approval.v === 2 ? approval.executionOriginV1 : null, catalog: getMcpServerCatalogSnapshot({ serverId, accountId }),
        requests: homes.requests.map(({ path }) => path) })).not.toBeNull());
    expect(hook.getCurrent().alwaysLabel).toBe('Always for Gemini in happier');
    expect(hook.getCurrent().reason).toBe(requested.reason);
    await act(async () => { await hook.getCurrent().choose?.(choice === 'reject' ? 'reject' : 'always'); });
    if (choice === 'reject' || choice === 'cannot_resume') {
        expect(hook.getCurrent().state?.status).toBe(choice === 'reject' ? 'rejected' : 'decision_failed');
        expect(revision).toBe(1); expect(row.metadataVersion).toBe(1);
    } else {
        expect(hook.getCurrent().state, JSON.stringify({ calls: machineTransport.mock.calls,
            settled: homes.artifacts(serverId).readPlainBody(artifact.id), requests: homes.requests.map(({ path }) => path) }))
            .toMatchObject({ status: 'always_saved', approved: true });
        const settled = ApprovalRequestSchema.parse(JSON.parse(homes.artifacts(serverId).readPlainBody(artifact.id)!));
        const result = settled.execution?.ok ? SessionCapabilitiesSetOutputV1Schema.parse(settled.execution.result) : null;
        expect(result).toMatchObject({ ok: true, previous: 'inherit', applyTiming: { t: 'next_turn' } });
        if (!result?.ok) throw new Error('Expected successful capability execution');
        if (row.ownerMetadata?.t !== 'plain') throw new Error('Expected Plain Session owner metadata');
        const appliedMetadata = projectSessionOwnerCompatibilityViewV1({ sharedMetadata: { v: 1 }, ownerMetadata: row.ownerMetadata.v });
        expect(appliedMetadata)
            .toMatchObject({ mcpSelectionV1: { forceIncludeServerIds: ['linear-id'] } });
        const change = readSessionCapabilityApplyChange(appliedMetadata, () => 'Linear');
        expect(sessionCapabilityApplyNotice({ change, pendingApply: readPendingCapabilityApplyV1(appliedMetadata),
            applyTiming: { mcp: result.applyTiming, skills: { t: 'next_turn' } },
            machineOnline: true, machineName: 'MacBook', turnSettled: true })?.key).toBe('joinsNextTurn');
        expect(resolveReachV1(catalog.bindings.map(({ serverId: _id, ...rule }) => rule), context).enabled).toBe(true);
        expect(catalog.bindings.find(rule => rule.id === 'general')?.enabled).toBe(true);
        await act(async () => { expect(await hook.getCurrent().undoAlways?.()).toEqual({ ok: true }); });
        expect(resolveReachV1(catalog.bindings.map(({ serverId: _id, ...rule }) => rule), context).enabled).toBe(false);
        await hook.rerender(settled);
        await act(async () => { expect(await hook.getCurrent().undoSession()).toMatchObject({ ok: true, result: { ok: true, state: 'inherit' } }); });
        if (row.ownerMetadata?.t !== 'plain') throw new Error('Expected Plain Session owner metadata after Undo');
        expect(projectSessionOwnerCompatibilityViewV1({ sharedMetadata: { v: 1 }, ownerMetadata: row.ownerMetadata.v }))
            .toMatchObject({ mcpSelectionV1: { forceIncludeServerIds: [] } });
    }
});
