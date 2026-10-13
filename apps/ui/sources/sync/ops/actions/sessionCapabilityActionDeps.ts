import { getAgentCore, getAgentResumeConfig, resolveAgentIdFromSessionMetadata, resolveAgentRuntimeControlSurfaceForSession } from '@happier-dev/agents';
import { MetadataSchema } from '@happier-dev/session-core/state';
import { readCapabilityLaunchRestartFromMetadataV1, readSessionCapabilityAgentFactsV1 } from '@happier-dev/protocol/reach/capabilityApplyTimingV1';
import { readPendingCapabilityApplyV1, readCapabilitySelectionApplyV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';
import { readRuntimeDescriptorV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor-compat';
import { SpawnCapabilitiesPreviewOutputV1Schema, SessionCapabilitiesGetOutputV1Schema } from '@happier-dev/protocol/actions/specs/sessionCapabilities';
import type { ActionExecutorDeps, ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { resolveSessionCapabilityItemIdentityV1, type SessionCapabilitiesActionPortV1 } from '@happier-dev/protocol/actions/executor/sessionCapabilities';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError } from '@happier-dev/protocol/rpcErrors';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readSessionSnapshotForAuthority, SessionSnapshotReadError } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readMcpServerCatalogInContext } from '@/sync/api/account/apiMcpServerCatalog';
import { readSkillLibraryCatalog } from '@happier-dev/protocol/prompts/library/skills/readSkillLibraryCatalog';
import { readCachedDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { readCurrentProjectedAgentCapabilities } from '@/agents/backendCatalog/currentAgentCapabilities';
import { readMcpPluginItemMetadataFromProjectionV1 } from '@happier-dev/protocol/mcp/servers/pluginItemsV1';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { isMachineRequestReachabilityFailure } from '@/sync/domains/machines/reachability/machineReachability';
import type { LazyActionAccountContext } from './actionAccountContext';
import { sync } from '@/sync/sync';

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Bind the protocol selection writer and machine preview to the invocation's captured Home. */
export function createUiSessionCapabilityActionDeps(account: LazyActionAccountContext | undefined): Pick<ActionExecutorDeps,
    'sessionCapabilities' | 'sessionCapabilitiesGet' | 'spawnCapabilitiesPreview'> {
    if (!account) return {};
    const assertCurrent = (context: ActionExecutorContext) => {
        account.assertCurrent(); context.signal?.throwIfAborted();
        if (context.serverId && !areServerProfileIdentifiersEquivalent(context.serverId, account.serverId)) throw new Error('server_target_mismatch');
    };
    const readSession = async (sessionId: string, context: ActionExecutorContext) => {
        assertCurrent(context);
        try {
            const snapshot = await runWithServerRequestAuthorityForServerAccountScope({ scope: account.accountLifetime.scope, activeRequest: account.request },
                authority => readSessionSnapshotForAuthority({ authority, sessionId, isCurrent: account.accountLifetime.isCurrent }));
            assertCurrent(context);
            return snapshot.session;
        } catch (failure) {
            if (failure instanceof SessionSnapshotReadError && failure.errorCode === 'not_found') return null;
            throw failure;
        }
    };
    const port: SessionCapabilitiesActionPortV1 = {
        readSession: async (input, context) => {
            const session = await readSession(input.sessionId, context);
            const metadata = session ? readSessionOwnerMetadataView(session) : null;
            if (!session) return null;
            if (!metadata) throw Object.assign(new Error('Session owner metadata unavailable'), { code: 'session_unavailable' });
            const agentId = resolveAgentIdFromSessionMetadata(metadata);
            const core = agentId ? getAgentCore(agentId) : null;
            const runtime = agentId ? resolveAgentRuntimeControlSurfaceForSession({ agentId, metadata }) : null;
            const cached = readCachedDaemonMergedProjectionCacheEntry({ machineId: metadata.machineId, serverId: account.serverId });
            const projection = cached && (cached.kind === 'ready' || cached.kind === 'error') ? cached.inputs?.pluginProjectionV2 : null;
            const projected = projection && agentId ? readCurrentProjectedAgentCapabilities({ projection, agentId }) : null;
            const actual = readSessionCapabilityAgentFactsV1(metadata);
            if (session.active && readRuntimeDescriptorV1FromMetadata(metadata) && !actual) {
                throw Object.assign(new Error('Session capability facts unavailable'), { code: 'session_unavailable' });
            }
            return { metadata, revision: session.metadataVersion, sessionRunning: session.active,
                agent: actual ?? { vendorResume: runtime?.resume.vendorResume ?? (agentId ? getAgentResumeConfig(agentId)?.vendorResume : null)
                    ?? (projected?.capabilities?.sessions?.open.includes('resume') ? 'supported' : 'unsupported'),
                    skillsLiveReload: projected?.capabilities?.skills?.liveReload ?? core?.skills?.liveReload ?? 'unsupported' },
                launchRestart: readCapabilityLaunchRestartFromMetadataV1(metadata) };
        },
        resolveItem: async (input, context) => {
            assertCurrent(context);
            if (input.kind === 'native_skill') return input.id;
            if (input.kind === 'skill') {
                const items = await readSkillLibraryCatalog({ list: options => account.listArtifacts(options) }, context.signal);
                assertCurrent(context);
                return resolveSessionCapabilityItemIdentityV1(items, input.id);
            }
            const catalog = await readMcpServerCatalogInContext(account, context.signal);
            assertCurrent(context);
            if (catalog.status !== 'ready') throw new Error('catalog_unavailable');
            const catalogId = resolveSessionCapabilityItemIdentityV1(catalog.catalog.servers, input.id);
            if (catalogId) return catalogId;
            const session = await readSession(input.sessionId, context);
            const metadata = session ? readSessionOwnerMetadataView(session) : null;
            const cached = readCachedDaemonMergedProjectionCacheEntry({ machineId: metadata?.machineId, serverId: account.serverId });
            const projection = cached && (cached.kind === 'ready' || cached.kind === 'error') ? cached.inputs?.pluginProjectionV2 : null;
            return projection && readMcpPluginItemMetadataFromProjectionV1(projection).some(item => item.id === input.id) ? input.id : null;
        },
        writeMetadata: async (input, context) => {
            assertCurrent(context);
            let committed = false;
            try {
                await sync.patchSessionMetadataWithRetry(input.sessionId, () => {
                    assertCurrent(context); return MetadataSchema.parse(input.metadata);
                }, { serverId: account.serverId, accountLifetime: account.accountLifetime, expectedMetadataRevision: input.expectedRevision,
                    onMetadataCommitted: () => { committed = true; } });
                return committed ? 'updated' : 'conflict';
            } catch (failure) {
                const code = record(failure)?.code;
                if (code === 'metadata_tuple_conflict' || code === 'conflict') return 'conflict';
                throw failure;
            }
        },
    };
    const preview: NonNullable<ActionExecutorDeps['spawnCapabilitiesPreview']> = async (input, context) => {
        assertCurrent(context);
        try {
            const response = record(await machineRpcWithServerScope({ machineId: input.machineId, serverId: account.serverId, accountId: account.accountId,
                method: RPC_METHODS.DAEMON_MCP_SERVERS_PREVIEW, payload: input, signal: context.signal }));
            assertCurrent(context);
            if (response?.ok !== true) return { ok: false, reason: isMachineRequestReachabilityFailure(response)
                || isMachineRequestReachabilityFailure({ code: response?.errorCode }) ? 'machine_unreachable' : 'invalid_input' };
            const parsed = SpawnCapabilitiesPreviewOutputV1Schema.safeParse({ ok: true, machinePlatform: response.machinePlatform,
                mcp: response.mcp, skills: response.skills, applyTiming: response.applyTiming });
            return parsed.success ? parsed.data : { ok: false, reason: 'invalid_input' };
        } catch (failure) {
            assertCurrent(context);
            if (isMachineRequestReachabilityFailure(failure)) return { ok: false, reason: 'machine_unreachable' };
            if (isRpcMethodNotAvailableError(failure) || isRpcMethodNotFoundError(failure)) return { ok: false, reason: 'invalid_input' };
            throw failure;
        }
    };
    return { sessionCapabilities: port, spawnCapabilitiesPreview: preview,
        sessionCapabilitiesGet: async (input, context) => {
            try {
                const session = await readSession(input.sessionId, context);
                if (!session) return { ok: false, code: 'not_found' };
                const metadata = readSessionOwnerMetadataView(session);
                if (!metadata || !metadata.machineId) return { ok: false, code: 'session_unavailable' };
                const agentId = resolveAgentIdFromSessionMetadata(metadata);
                if (!agentId) return { ok: false, code: 'session_unavailable' };
                const response = record(await machineRpcWithServerScope({ machineId: metadata.machineId, serverId: account.serverId, accountId: account.accountId,
                    method: RPC_METHODS.DAEMON_MCP_SERVERS_PREVIEW, payload: { machineId: metadata.machineId, sessionId: input.sessionId, agentId,
                        ...(metadata.path ? { directory: metadata.path } : {}) }, signal: context.signal }));
                assertCurrent(context);
                if (response?.ok !== true) return { ok: false, code: 'session_unavailable' };
                const mcp = record(response?.mcp);
                const pending = readCapabilitySelectionApplyV1(metadata);
                const detail = pending.mcp ?? pending.skills;
                return SessionCapabilitiesGetOutputV1Schema.parse({ ok: true, mcp: { items: mcp?.items }, skills: response?.skills,
                    pendingApply: { ...readPendingCapabilityApplyV1(metadata), ...(detail ?? {}) }, applyTiming: response?.applyTiming });
            } catch (failure) {
                assertCurrent(context);
                return { ok: false, code: 'session_unavailable' };
            }
        } };
}
