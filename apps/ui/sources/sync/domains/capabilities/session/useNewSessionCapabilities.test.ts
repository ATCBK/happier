import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, flushHookEffects } from '@/dev/testkit';
import { DaemonMcpServersPreviewRequestSchema } from '@happier-dev/protocol/mcp/servers/previewV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createRpcCallError } from '@happier-dev/protocol/rpcErrors';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { createSessionOwnerMetadataV1, createPlainSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { SessionCapabilitySelectionV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();

const transport = vi.hoisted(() => vi.fn<(input: unknown) => Promise<unknown>>());
// The real RPC codec and all selection logic run beneath this network transport boundary.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: transport }));
let serverId: string;
const previewResponse = { ok: true, machinePlatform: 'posix', mcp: { strictMode: false, items: [], detected: [] },
    skills: { items: [], plan: { plan: 'none', items: [], nativeDisables: [], diagnostics: [] } },
    applyTiming: { mcp: { t: 'session_not_running' }, skills: { t: 'session_not_running' } } };
function isPreviewRequest(input: unknown): input is { payload: unknown } {
    return input !== null && typeof input === 'object' && 'method' in input && input.method === RPC_METHODS.DAEMON_MCP_SERVERS_PREVIEW && 'payload' in input;
}

describe('useNewSessionCapabilities', () => {
    beforeEach(async () => {
        await homes.reset();
        await loadSyncSingletonForTests();
        serverId = await homes.addHome({ name: 'Preview', serverUrl: 'https://capability-preview.test', accountId: 'preview-owner' });
        homes.answer(serverId, '/v1/account/encryption/currentness', { body: {
            mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        } });
        transport.mockReset();
        transport.mockResolvedValue(previewResponse);
    });
    it('observes a host acknowledgment from metadata even while a demanded preview still says pending', async () => {
        const sessionId = 'c123456789012345678901234';
        const metadata = { machineId: 'machine-1', path: '/repo', host: 'host', flavor: 'codex',
            mcpSelectionV1: { v: 1 as const, managedServersEnabled: true, forceIncludeServerIds: ['server'], forceExcludeServerIds: [] },
            mcpSelectionRestartRequiredV1: { v: 1 as const, appliedSelection: { v: 1 as const, managedServersEnabled: true, forceIncludeServerIds: [], forceExcludeServerIds: [] } } };
        transport.mockResolvedValue(previewResponse);
        const owner = createSessionOwnerMetadataV1({ metadata });
        if (!owner.ok) throw new Error('Invalid metadata');
        const row = SessionCurrentProjectionRecordV1Schema.parse({ id: sessionId, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
            encryptionMode: 'plain', metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }), metadataVersion: 1,
            ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata), agentState: null, agentStateVersion: 1,
            dataEncryptionKey: null, share: null, responsibleAccountId: null, responsibleAccount: null,
            effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionAccessFixture().capabilities } });
        for (const suffix of ['', '?accessProjectionVersion=1']) homes.answer(serverId, `GET /v2/sessions/${sessionId}${suffix}`, { body: { session: row } });
        const { useSessionCapabilities } = await import('./useSessionCapabilities');
        const hook = await renderHook(() => {
            const [current, setCurrent] = React.useState<unknown>(metadata);
            return { ...useSessionCapabilities(sessionId, current, { serverId }), setCurrent };
        });
        await act(async () => { hook.getCurrent().demandPreview(); });
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
        expect(hook.getCurrent().pendingApply.mcp).toBe(true);
        await act(async () => { const { mcpSelectionRestartRequiredV1: _marker, ...acknowledged } = metadata; hook.getCurrent().setCurrent(acknowledged); });
        expect(hook.getCurrent().pendingApply.mcp).toBe(false);
    });

    it('gets a stopped Session through its owned machine and reads pending apply from the exact metadata codec', async () => {
        const sessionId = 'c123456789012345678901234';
        const owner = createSessionOwnerMetadataV1({ metadata: { path: '/repo', host: 'host', machineId: 'machine-1', flavor: 'codex',
            mcpSelectionV1: { v: 1, managedServersEnabled: true, forceIncludeServerIds: ['server'], forceExcludeServerIds: [] },
            mcpSelectionRestartRequiredV1: { v: 1, appliedSelection: { v: 1, managedServersEnabled: true, forceIncludeServerIds: [], forceExcludeServerIds: [] } } } });
        if (!owner.ok) throw new Error('Invalid owner metadata fixture');
        const row = SessionCurrentProjectionRecordV1Schema.parse({ id: sessionId, seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
            encryptionMode: 'plain', metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }), metadataVersion: 1,
            ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata), agentState: null, agentStateVersion: 1,
            dataEncryptionKey: null, share: null, responsibleAccountId: null, responsibleAccount: null,
            effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionAccessFixture().capabilities } });
        for (const suffix of ['', '?accessProjectionVersion=1']) homes.answer(serverId, `GET /v2/sessions/${sessionId}${suffix}`, { body: { session: row } });
        transport.mockImplementation(async input => {
            if (!isPreviewRequest(input)) return previewResponse;
            expect(input).toMatchObject({ machineId: 'machine-1', serverId, payload: { sessionId } });
            expect(DaemonMcpServersPreviewRequestSchema.safeParse(input.payload).success).toBe(true);
            return previewResponse;
        });
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const result = await createDefaultActionExecutor().execute('session.capabilities.get', { sessionId }, { serverId, surface: 'ui', authority: 'present_user' });
        expect(result, JSON.stringify({ result, calls: transport.mock.calls })).toMatchObject({ ok: true, result: { ok: true, pendingApply: { mcp: true, skills: false }, mcp: { items: [] } } });
    });

    it.each(['invalid_request', 'unreachable', 'missing_method'] as const)('projects %s from the genuine preview transport to the strict Action failure', async failure => {
        transport.mockImplementation(async input => {
            if (!isPreviewRequest(input)) return previewResponse;
            if (failure === 'invalid_request') return { ok: false, errorCode: 'invalid_request', error: 'invalid input' };
            if (failure === 'missing_method') throw createRpcCallError({ error: 'Method not available', errorCode: 'RPC_METHOD_NOT_AVAILABLE' });
            throw Object.assign(new Error('offline'), { code: 'machine_offline' });
        });
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const result = await createDefaultActionExecutor().execute('sessions.spawn.capabilities.preview', {
            machineId: 'machine-1', agentId: 'codex', directory: '/repo',
        }, { serverId, surface: 'ui', authority: 'present_user' });
        expect(result).toMatchObject({ ok: true, result: { ok: false, reason: failure === 'unreachable' ? 'machine_unreachable' : 'invalid_input' } });
    });

    it('rejects a malformed RPC success discriminator rather than laundering it into an Action success', async () => {
        transport.mockResolvedValue({ ...previewResponse, ok: 'true' });
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        expect(await createDefaultActionExecutor().execute('sessions.spawn.capabilities.preview', { machineId: 'machine-1', agentId: 'codex' },
            { serverId, surface: 'ui', authority: 'present_user' }))
            .toMatchObject({ ok: true, result: { ok: false, reason: 'invalid_input' } });
    });

    it.each(['missing', 'unreadable', 'home_failure', 'ambiguous404'] as const)('refuses %s Session snapshots with a typed get/set result before mutation', async availability => {
        const sessionId = 'c123456789012345678901234';
        const row = SessionCurrentProjectionRecordV1Schema.parse({ id: sessionId, seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
            encryptionMode: 'e2ee', metadataLayoutVersion: 1, metadata: 'unavailable-shared-ciphertext', metadataVersion: 1,
            ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({ ownerMetadata: { v: 1 }, material: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
                randomBytes: size => new Uint8Array(size).fill(5) }),
            agentState: null, agentStateVersion: 1, dataEncryptionKey: null, share: null,
            responsibleAccountId: null, responsibleAccount: null,
            effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionAccessFixture().capabilities } });
        for (const suffix of ['', '?accessProjectionVersion=1']) homes.answer(serverId, `GET /v2/sessions/${sessionId}${suffix}`,
            availability === 'unreadable' ? { body: { session: row } } : { status: availability === 'missing' || availability === 'ambiguous404' ? 404 : 503,
                body: availability === 'missing' ? { error: 'Session not found' } : {} });
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const executor = createDefaultActionExecutor();
        const context = { serverId, surface: 'ui' as const, authority: 'present_user' as const };
        const code = availability === 'missing' ? 'not_found' : 'session_unavailable';
        expect(await executor.execute('session.capabilities.get', { sessionId }, context)).toMatchObject({ ok: true, result: { ok: false, code } });
        expect(await executor.execute('session.capabilities.set', { sessionId, kind: 'native_skill', id: 'lint', state: 'off' }, context))
            .toMatchObject({ ok: true, result: { ok: false, code } });
        expect(homes.requests.some(request => request.path.includes('/sessions/') && request.input !== null)).toBe(false);
        expect(transport.mock.calls.some(([input]) => isPreviewRequest(input))).toBe(false);
    });

    it('updates a draft optimistically without losing the other capability kind and previews only on demand', async () => {
        const { useNewSessionCapabilities } = await import('./useNewSessionCapabilities');
        const hook = await renderHook(() => {
            const [selection, setSelection] = React.useState<SessionCapabilitySelectionV1>({
                mcp: { v: 1, managedServersEnabled: true, forceIncludeServerIds: ['server-a'], forceExcludeServerIds: [] },
            });
            return useNewSessionCapabilities({ machineId: 'machine-1', directory: '/repo', agentId: 'codex', enabled: true, selection, setSelection });
        });
        expect(transport).not.toHaveBeenCalled();
        await act(async () => hook.getCurrent().setItem('skill', 'skill-a', 'on'));
        expect(hook.getCurrent().selection).toMatchObject({ mcp: { forceIncludeServerIds: ['server-a'] }, skills: { forceIncludeSkillIds: ['skill-a'] } });
        const unchanged = hook.getCurrent().selection;
        await act(async () => hook.getCurrent().setItem('skill', 'skill-a', 'on'));
        expect(hook.getCurrent().selection).toBe(unchanged);
        expect(hook.getCurrent().previewStatus).toBe('idle');
        await act(async () => { hook.getCurrent().demandPreview(); await flushHookEffects(); });
        expect(hook.getCurrent().previewStatus, JSON.stringify({ error: hook.getCurrent().error, calls: transport.mock.calls })).toBe('ready');
        expect(transport).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({
            capabilitySelection: expect.objectContaining({ mcp: { v: 1, managedServersEnabled: true, forceIncludeServerIds: ['server-a'], forceExcludeServerIds: [] },
                skills: expect.objectContaining({ forceIncludeSkillIds: ['skill-a'] }) }),
        }) }));
        expect(hook.getCurrent().lastKnownPreview).toMatchObject({ ok: true, mcp: { items: [], detected: [] }, skills: { items: [] } });
        transport.mockRejectedValueOnce(Object.assign(new Error('Machine offline'), { code: 'machine_offline' }));
        await act(async () => hook.getCurrent().refresh());
        expect(hook.getCurrent().previewStatus).toBe('unreachable');
        expect(hook.getCurrent().lastKnownPreview).toMatchObject({ ok: true, mcp: { items: [] } });
        transport.mockRejectedValueOnce(createRpcCallError({ error: 'Method not found', errorCode: 'RPC_METHOD_NOT_AVAILABLE' }));
        await act(async () => hook.getCurrent().refresh());
        expect(hook.getCurrent().previewStatus).toBe('error');
        expect(hook.getCurrent().lastKnownPreview).not.toBeNull();
    });
});
