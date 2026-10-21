import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
import { renderHook } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { AuthTokenProvenanceSchema } from '@happier-dev/protocol/auth/authToken';
import { getActionSpec, type PublicActionInputById, type PublicActionResultById } from '@happier-dev/protocol/actions/actionSpecs';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { ReviewEngineListItemSchema } from '@happier-dev/protocol/reviews/reviewEngines';
import type { CapabilitiesDetectResponse } from '@happier-dev/protocol/capabilities';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { CANONICAL_AGENT_IDS } from '@/agents/registry/registryCore';
import { buildAgentUniverseBackendTargetKey } from '@/agents/catalog/agentUniverse';
import { useSessionActionFieldOptions, useSessionActionFieldOptionsForRowHeight } from '@/components/sessions/actions/useSessionActionFieldOptions';
import { prefetchMachineCapabilities } from '@/hooks/server/useMachineCapabilitiesCache';
import { buildTranscriptItemHeightSignatureKey } from '@/components/sessions/transcript/measurement/transcriptItemHeightCache';
import { AppSessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/appSessionTranscriptSource';
import { getStorage } from '@/sync/domains/state/storage';
import type { StorageState } from '@/sync/store/types';
import type { SessionActionDraft } from '@/sync/domains/sessionActions/sessionActionDraftTypes';
import { useTranscriptItemsPipeline } from './useTranscriptItemsPipeline';

type Deps = Parameters<typeof useTranscriptItemsPipeline>[0];
const daemon = vi.hoisted(() => {
    const calls: string[] = [];
    const backends: Record<string, { available: boolean; intents: string[]; title: string }> = {};
    return { calls, backends };
});
installSessionActionRpcBoundary(request => {
    const method = request.method.slice(request.method.indexOf(':') + 1);
    daemon.calls.push(method);
    if (method === RPC_METHODS.CAPABILITIES_DETECT) return {
        protocolVersion: 1,
        results: { 'tool.executionRuns': { ok: true, checkedAt: Date.now(), data: { backends: daemon.backends } } },
    } satisfies CapabilitiesDetectResponse;
    // This daemon has no external Agent UI contributions; bundled Agent choices remain real.
    if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
        throw new RpcError('No external Agent contributions', RPC_ERROR_CODES.METHOD_NOT_FOUND);
    }
    throw new Error('Unexpected daemon RPC: ' + method);
});
await loadSyncSingletonForTests();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let fixtureIndex = 0;
let serverId: string;
let draft: SessionActionDraft;
let accountSettings: StorageState['settings'];
type OptionsInput = PublicActionInputById['review.engines.list'];
type InventoryOptions = PublicActionResultById['action.options.resolve']['options'];
let inventoryOptions: InventoryOptions;
const inventoryReads: Readonly<{ input: OptionsInput; machineId: string }>[] = [];
function initialInventoryOptions(): InventoryOptions {
    // External daemon inventory facts, not a client-side capability projection.
    return [
        { value: CANONICAL_AGENT_IDS[0]!, label: 'First review engine' },
        { value: CANONICAL_AGENT_IDS[1]!, label: 'Second review engine' },
    ];
}
const engineField = { path: 'engineIds', optionsSourceId: 'review.engines.available' };
const channelField = { path: 'channels', optionsSourceId: 'notifications.channels.available' };
const messageItem = { id: 'm1', kind: 'message' as const, messageId: 'm1', seq: 1, createdAt: 1 };
const vendorId = 'vendor-review-service';
function Source(props: React.PropsWithChildren) {
    return <AppSessionTranscriptSourceProvider sessionId="s1" serverId={serverId}>{props.children}</AppSessionTranscriptSourceProvider>;
}
async function writeStore(patch: Partial<StorageState>) {
    // Model a synced Account preference change at both the HTTP and UI boundaries.
    if (patch.settings) accountSettings = patch.settings;
    await act(async () => { getStorage().setState(patch); });
}
function session(machineId = 'machine-1', updatedAt = 1) {
    return createSessionFixture({
        id: 's1', serverId, active: true, updatedAt,
        metadata: { path: '/workspace', host: 'tester.local', machineId },
    });
}
async function setDrafts(values: SessionActionDraft[]) {
    await writeStore({ sessionActionDraftsByAddressKey: { [JSON.stringify([serverId, 's1'])]: values } });
}
function deps(resolveActionDraftFieldOptions: Deps['resolveActionDraftFieldOptions']): Deps {
    const items = [messageItem, { id: 'draft:d1', kind: 'action-draft' as const, draft }];
    return {
        activeTargetWindowTargetRef: { current: null },
        activeThinkingMessageId: null,
        canonicalWindowedItemsRef: { current: items },
        committedMessagesCount: 1,
        expandedToolCallsAnchorMessageIds: new Set(),
        forkMessageMetadataById: null,
        getMessageById: () => null,
        getMessageRevisionById: () => 1,
        groupingMode: 'linear',
        isLoaded: true,
        jumpToSeq: null,
        items,
        itemsRef: { current: items },
        latestCommittedActivityKey: null,
        listDataRef: { current: items },
        listOrientation: 'standard',
        messagesById: {},
        preDecompositionItemsRef: { current: items },
        renderWindowIndexMapRef: { current: null },
        resolveActionDraftFieldOptions,
        resolveThinkingExpanded: () => false,
        rowFontScaleKey: 'default',
        rowWidthBucket: 'w',
        sessionActive: true,
        sessionId: 's1',
        sessionThinking: false,
        targetWindowActiveRef: { current: false },
        transcriptToolCallsCollapsedPreviewCountSetting: 3,
        toolCallsGroupChromeVariant: 'feed_background',
    };
}
async function renderPipeline(card = false, expectedStatus: 'ready' | 'failed' = 'ready') {
    let runs = 0;
    const stableDeps = deps(() => []);
    const hook = await renderHook(() => {
        runs += 1;
        const resolver = useSessionActionFieldOptionsForRowHeight('s1', serverId);
        const cardResolver = useSessionActionFieldOptions('s1', serverId);
        return {
            resolver,
            cardResolver,
            pipeline: useTranscriptItemsPipeline({ ...stableDeps, resolveActionDraftFieldOptions: resolver }),
        };
    }, { wrapper: Source });
    const read = () => {
        const value = hook.getCurrent();
        return {
            ...value,
            runs,
            draftKey: buildTranscriptItemHeightSignatureKey(value.pipeline.buildRowShellSignature(stableDeps.items[1]!)),
            messageKey: buildTranscriptItemHeightSignatureKey(value.pipeline.buildRowShellSignature(messageItem)),
        };
    };
    await vi.waitFor(() => {
        const resolver = card ? hook.getCurrent().cardResolver : hook.getCurrent().resolver;
        const field = card ? channelField : engineField;
        const state = resolver.state?.(field);
        expect(state, JSON.stringify(state)).toMatchObject({ status: expectedStatus });
        if (expectedStatus === 'ready') expect(resolver(field).length).toBeGreaterThan(0);
    });
    return { hook, read };
}
async function refreshCapabilities() {
    await act(async () => {
        await prefetchMachineCapabilities({
            machineId: 'machine-1', serverId,
            request: { requests: [{ id: 'tool.executionRuns' }], bypassCache: true },
        });
    });
}
beforeEach(async () => {
    daemon.calls.length = 0;
    daemon.backends = {};
    accountSettings = { ...getStorage().getState().settings, backendEnabledByTargetKey: {} };
    const http = createHomeHubArtifactHttpBoundary('account-a');
    // Each test has a fresh real Home namespace, not a reset or forged cache.
    fixtureIndex += 1;
    const serverUrl = `http://transcript-options-${fixtureIndex}.test`;
    const serverIdentityId = `srv_transcript_options_${fixtureIndex}`;
    inventoryOptions = initialInventoryOptions();
    inventoryReads.length = 0;
    const external = await createExternalActionAccountHttpBoundary({
        serverUrl, serverIdentityId, accountId: 'account-a', machineId: 'machine-1',
        actionId: 'review.engines.list', tokenEpoch: 0, requesterInvocation: 'none',
        execute: (rawInput, { target }) => {
            if (target.kind !== 'machine') throw new Error('Expected exact-Machine options inventory target');
            const input = getActionSpec('review.engines.list').inputSchema.parse(rawInput) as OptionsInput;
            inventoryReads.push({ input, machineId: target.machineId });
            return { items: inventoryOptions.map(option => ReviewEngineListItemSchema.parse({
                engineId: option.value, value: option.value, label: option.label, enabled: true,
                capabilities: { structuredNarration: true },
            })) };
        },
    });
    const credentials = { token: `header.${Buffer.from(JSON.stringify({
        sub: 'account-a', tokenEpoch: 0,
        provenance: AuthTokenProvenanceSchema.parse({ v: 1, kind: 'account', authority: 'present_user' }),
    })).toString('base64url')}.signature` };
    connection = await restoreServerAccountForTest({ serverUrl, serverIdentityId, credentials, accountId: 'account-a', request: async (input, init) => {
        const externalResponse = await external.handle(new URL(String(input)), init);
        if (externalResponse) return externalResponse;
        if (new URL(String(input)).pathname === '/v2/account/settings') {
            return Response.json({ content: { t: 'plain', v: accountSettings }, version: 1 });
        }
        // A current empty Account catalog is ready, not an unavailable read.
        if (new URL(String(input)).pathname === ACP_CATALOG_ROWS_ROUTE_V1) {
            return Response.json(AcpCatalogRowReadResponseV1Schema.parse({
                status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, definitions: [] } },
            }));
        }
        return http.request(input, init);
    } });
    serverId = captureActiveServerAccountScopeLifetime()!.scope.serverId;
    draft = { id: 'd1', address: { serverId, sessionId: 's1' }, accountId: 'account-a', actionId: 'review.start', createdAt: 1,
        status: 'editing', input: { engineIds: [CANONICAL_AGENT_IDS[1]!], instructions: 'Review.', changeType: 'all', base: { kind: 'none' } } };
    const machines = [createMachineFixture({ id: 'machine-1', storageMode: 'plain', activeAt: Date.now() }), createMachineFixture({ id: 'machine-2', storageMode: 'plain', activeAt: Date.now() })];
    await writeStore({ settingsScope: { serverId, accountId: 'account-a' }, profileScope: { serverId, accountId: 'account-a' },
        sessions: { s1: session() }, machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
        machineListByServerId: { [serverId]: machines }, machineListStatusByServerId: { [serverId]: 'idle' },
        settings: { ...getStorage().getState().settings, backendEnabledByTargetKey: {} } });
    await setDrafts([draft]);
});
afterEach(async () => { await connection?.dispose(); connection = undefined; });
// The loader only bridges Metro's call-time require; no Action behavior is replaced.

describe('transcript action-draft option key locality', () => {
    it('preserves unrelated row keys and only changes the draft geometry for changed options', async () => {
        const { hook, read } = await renderPipeline(); const baseline = read();
        const baselineReads = inventoryReads.length;
        await writeStore({ settings: { ...getStorage().getState().settings, transcriptScrollPinEnabled: false } });
        expect(read().runs).toBe(baseline.runs); expect(read().resolver).toBe(baseline.resolver);
        await writeStore({ settings: { ...getStorage().getState().settings, backendEnabledByTargetKey: { 'unknown-target': false } } });
        expect(read().resolver).toBe(baseline.resolver); expect(read().draftKey).toBe(baseline.draftKey);
        expect(inventoryReads).toHaveLength(baselineReads);
        // The daemon publishes the changed enabled inventory. The UI preference
        // invalidates the read; it must not filter or invent remote choices.
        inventoryOptions = initialInventoryOptions().slice(1);
        await writeStore({ settings: { ...getStorage().getState().settings, backendEnabledByTargetKey: { [buildAgentUniverseBackendTargetKey(CANONICAL_AGENT_IDS[0]!)]: false } } });
        await vi.waitFor(() => {
            expect(inventoryReads.length).toBeGreaterThan(baselineReads);
            expect(read().resolver(engineField)).toEqual(inventoryOptions);
            expect(read().draftKey).not.toBe(baseline.draftKey);
        });
        expect(read().messageKey).toBe(baseline.messageKey); await hook.unmount();
    });
    it('does not probe capabilities without a draft and starts the real read when a draft appears', async () => {
        await setDrafts([]); daemon.calls.length = 0;
        const hook = await renderHook(() => useSessionActionFieldOptionsForRowHeight('s1', serverId), { wrapper: Source });
        expect(hook.getCurrent()(engineField)).toEqual([]);
        expect(daemon.calls).not.toContain(RPC_METHODS.CAPABILITIES_DETECT);
        expect(inventoryReads).toEqual([]);
        await setDrafts([draft]);
        await vi.waitFor(() => {
            expect(hook.getCurrent()(engineField).length).toBeGreaterThan(0);
            expect(daemon.calls).toContain(RPC_METHODS.CAPABILITIES_DETECT);
            expect(inventoryReads).toEqual(expect.arrayContaining([
                expect.objectContaining({ machineId: 'machine-1', input: expect.objectContaining({
                    sessionId: null, machineId: 'machine-1',
                }) }),
            ]));
        });
        await hook.unmount();
    });
    it('re-reads the remote inventory after a capabilities change and re-keys only the draft for changed choices', async () => {
        const { hook, read } = await renderPipeline(); const baseline = read();
        const baselineReads = inventoryReads.length;
        daemon.backends = { [vendorId]: { available: true, intents: ['review'], title: 'Vendor Review' } };
        inventoryOptions = [...initialInventoryOptions(), { value: vendorId, label: 'Vendor Review' }];
        await refreshCapabilities();
        await vi.waitFor(() => {
            expect(inventoryReads.length).toBeGreaterThan(baselineReads);
            expect(read().resolver(engineField).map(option => option.label)).toContain('Vendor Review');
        });
        const discovered = read(); expect(discovered.draftKey).not.toBe(baseline.draftKey);
        const discoveredReads = inventoryReads.length;
        daemon.backends = { [vendorId]: { available: true, intents: ['review'], title: 'Vendor Review Bot' } };
        // Preserve the original longer-label geometry transition: the row key
        // intentionally keys painted text extent, not same-length copy changes.
        inventoryOptions = [...initialInventoryOptions(), { value: vendorId, label: 'Vendor Review Bot' }];
        await refreshCapabilities();
        await vi.waitFor(() => {
            expect(inventoryReads.length).toBeGreaterThan(discoveredReads);
            expect(read().resolver(engineField).map(option => option.label)).toContain('Vendor Review Bot');
        });
        expect(read().draftKey).not.toBe(discovered.draftKey); expect(read().messageKey).toBe(baseline.messageKey); await hook.unmount();
    });
    it('keeps an unavailable notification draft visibly failed without changing row geometry on retry', async () => {
        draft = { ...draft, actionId: 'notifications.notify_me', input: { message: 'Ready', channels: ['plugin/channel'] } }; await setDrafts([draft]);
        const { hook, read } = await renderPipeline(true, 'failed'); const baseline = read();
        // Notify me is not a UI-exposed Action. Its options must not bypass that admission.
        // Availability-only height changes are covered by sessionActionFieldOptions.test.ts.
        expect(baseline.cardResolver.state?.(channelField)).toMatchObject({ status: 'failed', errorCode: 'action_disabled' });
        await act(async () => { hook.getCurrent().cardResolver.retry?.(); });
        await vi.waitFor(() => expect(read().cardResolver.state?.(channelField)).toMatchObject({ status: 'failed', errorCode: 'action_disabled' }));
        expect(read().draftKey).toBe(baseline.draftKey); expect(read().messageKey).toBe(baseline.messageKey); await hook.unmount();
    });
    it('does not rerender option consumers for unrelated session data and observes the real machine change', async () => {
        const { hook, read } = await renderPipeline(); const baseline = read();
        await writeStore({ sessions: { s1: session('machine-1', 2) } });
        expect(read().runs).toBe(baseline.runs); expect(read().resolver).toBe(baseline.resolver);
        await writeStore({ sessions: { s1: session('machine-2', 3) } });
        expect(read().runs).toBeGreaterThan(baseline.runs); await hook.unmount();
    });
});
