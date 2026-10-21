import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineProtocolObject } from '@happier-dev/plugin-sdk/protocol';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { PluginUiTargetedContributionsV1Schema } from '@happier-dev/protocol/plugins/ui';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { publishAppliedActiveServerRuntimeAvailability, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { storage } from '@/sync/domains/state/storage';

const projectionState = vi.hoisted(() => ({
    revision: 0,
    listeners: new Set<() => void>(),
}));
const targetedReadMock = vi.hoisted(() => vi.fn());
const describeMock = vi.hoisted(() => vi.fn());
const activeAccountLifetime = vi.hoisted(() => ({
    value: null as null | Readonly<{
        scope: Readonly<{ serverId: string; accountId: string }>;
        isCurrent(): boolean;
        onRetire(cancel: () => void): Readonly<{ dispose(): void }>;
    }>,
}));

// The machine RPC transport is this owner's boundary; the revision registry is
// the real one so an invalidation behaves exactly as in the app.
vi.mock('@/sync/ops/machineContributionRegistryProjection', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/ops/machineContributionRegistryProjection')>()),
    machinePluginUiTargetedContributionsRead: targetedReadMock,
    machineContributionRegistryProjectionDescribe: describeMock,
}));

// No scoped RPC can escape this target-read transport fixture. Retain the
// operation module's real neighbouring exports without loading a live channel.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: vi.fn(),
}));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
let focusedHomeId = '';

const sourceCustody = { kind: 'development', registeredRootId: 'triage-root' } as const;

function snapshot(occurrenceId: string) {
    return {
        target: { pluginId: 'acme.triage', occurrenceId, sourceCustody },
        points: [],
    };
}

function mount(occurrenceId: string) {
    return {
        kind: 'targetedSurface',
        target: { pluginId: 'acme.triage', occurrenceId, sourceCustody },
        inputSchema: defineProtocolObject({}, { policy: 'closed' }).jsonSchema,
    };
}

// Load the shared publication graph outside an individual hook-case deadline.
const { loadDaemonMergedProjectionCacheEntry, clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const mountedTargetOwner = await import('./mountedTargetedContributions');

/** Mirrors the Host join: one routed binding supplies both target and controller custody. */
function useMountedTargetedContributions(params: Omit<Parameters<typeof mountedTargetOwner.useMountedTargetedContributions>[0], 'accountLifetime'>) {
    const bindings = useServerCredentialAccountScopeBindings(params.serverId ? [params.serverId] : []);
    const accountLifetime = params.serverId
        ? bindings.values().next().value ?? null
        : captureActiveServerAccountScopeLifetime();
    const input = { ...params, accountLifetime };
    return mountedTargetOwner.useMountedTargetedContributions(input);
}

describe('useMountedTargetedContributions', () => {
    beforeEach(async () => {
        targetedReadMock.mockReset();
        describeMock.mockReset();
        await homes.reset();
        focusedHomeId = await homes.addHome({ name: 'Focused Home', serverUrl: 'https://mounted-home-a.test',
            serverIdentityId: 'server-1', accountId: 'account-a' });
        storage.setState({ profileScope: { serverId: focusedHomeId, accountId: 'account-a' } });
        publishAppliedActiveServerSnapshot({ serverId: focusedHomeId, serverUrl: 'https://mounted-home-a.test', generation: 1 });
        activeAccountLifetime.value = captureActiveServerAccountScopeLifetime();
        if (!activeAccountLifetime.value) throw new Error('Expected the focused Account lifetime');
    });

    afterEach(async () => {
        standardCleanup();
        publishAppliedActiveServerRuntimeAvailability(false);
        storage.setState(storage.getInitialState(), true);
        await homes.reset();
    });

    it('uses the routed Home lifetime while another Home is focused and withdraws it on that Home retirement', async () => {
        clearDaemonMergedProjectionCacheForTests();
        const focusedLifetime = activeAccountLifetime.value!;
        const homeB = await homes.addHome({ name: 'Routed Home', serverUrl: 'https://mounted-home-b.test',
            serverIdentityId: 'server-b', accountId: 'account-b', active: false });
        const binding = await renderHook(() => useServerCredentialAccountScopeBindings([homeB]));
        await vi.waitFor(() => expect(binding.getCurrent().get(homeB)?.accountId).toBe('account-b'));
        const lifetimeB = binding.getCurrent().get(homeB)!;
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 73 });
        describeMock.mockResolvedValue({ supported: true, projection });
        const cached = await loadDaemonMergedProjectionCacheEntry({ machineId: 'machine-routed', serverId: homeB, accountLifetime: lifetimeB });
        if (cached?.kind !== 'ready') throw new Error('Expected the routed Home projection');
        targetedReadMock.mockResolvedValue({ supported: true, targetedContributions: snapshot('occurrence-a'), targetedSurfaceMounts: [mount('occurrence-a')] });
        const rendered = await renderHook(() => useMountedTargetedContributions({ machineId: 'machine-routed', serverId: homeB,
            pluginId: 'acme.triage', mountedOccurrenceId: 'occurrence-a', enabled: true }));
        await flushHookEffects({ cycles: 2, turns: 2 });
        const request = targetedReadMock.mock.lastCall?.[1];
        expect(request?.accountLifetime.scope).toEqual({ serverId: homeB, accountId: 'account-b' });
        expect(rendered.getCurrent().phase).toBe('ready');
        expect(rendered.getCurrent().projectionInputs).toBe(cached.inputs);
        expect(focusedLifetime.isCurrent()).toBe(true);
        await act(async () => { publishAppliedActiveServerRuntimeAvailability(false); });
        await rendered.rerender();
        expect(focusedLifetime.isCurrent()).toBe(false);
        expect(request?.accountLifetime.isCurrent()).toBe(true);
        expect(rendered.getCurrent().projectionInputs).toBe(cached.inputs);

        let settleLateRead: ((result: Readonly<{ supported: true; targetedContributions: ReturnType<typeof snapshot>; targetedSurfaceMounts: ReturnType<typeof mount>[] }>) => void) | undefined;
        const lateRead = new Promise<Readonly<{ supported: true; targetedContributions: ReturnType<typeof snapshot>; targetedSurfaceMounts: ReturnType<typeof mount>[] }>>(resolve => { settleLateRead = resolve; });
        targetedReadMock.mockReturnValueOnce(lateRead).mockReturnValue(new Promise(() => {}));
        const { publishMachineContributionRegistryProjectionInvalidation } = await import('@/sync/ops/machineContributionRegistryProjection');
        await act(async () => { publishMachineContributionRegistryProjectionInvalidation({ machineId: 'machine-routed', serverId: homeB }); });
        const pendingRequest = targetedReadMock.mock.lastCall?.[1];
        expect(rendered.getCurrent().targetedContributions).toEqual(snapshot('occurrence-a'));
        await act(async () => { await homes.switchAccount(homeB, 'account-b-next'); });
        expect(lifetimeB.isCurrent()).toBe(false);
        expect(request?.accountLifetime.isCurrent()).toBe(false);
        expect(pendingRequest?.signal.aborted).toBe(true);
        await act(async () => { settleLateRead?.({ supported: true, targetedContributions: snapshot('late-private-occurrence'), targetedSurfaceMounts: [] }); });
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(rendered.getCurrent().targetedContributions).toBeNull();
        expect(rendered.getCurrent().projectionInputs).toBeNull();
        expect(rendered.getCurrent().pluginUiProjection).toBeNull();
    });

    it('reads only the target slice and prepares its mounts', async () => {
        targetedReadMock.mockResolvedValue({
            supported: true,
            targetedContributions: snapshot('occurrence-a'),
            targetedSurfaceMounts: [mount('occurrence-a')],
        });
        const rendered = await renderHook(() => useMountedTargetedContributions({
            machineId: 'machine-1',
            serverId: focusedHomeId,
            pluginId: 'acme.triage',
            mountedOccurrenceId: 'occurrence-a',
            enabled: true,
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(rendered.getCurrent()).toMatchObject({
            phase: 'ready',
            targetedContributions: snapshot('occurrence-a'),
            failure: null,
        });
        expect(rendered.getCurrent().preparedTargetedSurfaceMounts?.[0]?.inputValidation).toBeDefined();
        expect(targetedReadMock).toHaveBeenCalledWith('machine-1', expect.objectContaining({ serverId: focusedHomeId, pluginId: 'acme.triage' }));
        // The mount never asks for the machine-wide projection itself.
        expect(describeMock).not.toHaveBeenCalled();
    });

    it('publishes exact ready model inputs with the target and updates them from the existing machine publisher', async () => {
        clearDaemonMergedProjectionCacheForTests();
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 41 });
        describeMock.mockResolvedValue({ supported: true, projection });
        const input = { machineId: 'machine-published', serverId: focusedHomeId, accountLifetime: activeAccountLifetime.value };
        const first = await loadDaemonMergedProjectionCacheEntry(input);
        if (first?.kind !== 'ready') throw new Error('Expected admitted machine projection');
        targetedReadMock.mockResolvedValue({ supported: true, targetedContributions: snapshot('occurrence-a'), targetedSurfaceMounts: [mount('occurrence-a')] });
        const rendered = await renderHook(() => useMountedTargetedContributions({
            machineId: input.machineId, serverId: input.serverId, pluginId: 'acme.triage', mountedOccurrenceId: 'occurrence-a', enabled: true,
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(rendered.getCurrent().projectionInputs).toBe(first.inputs);
        expect(rendered.getCurrent().pluginUiProjection).toBe(first.inputs.pluginUiProjection);
        const prepared = rendered.getCurrent().preparedTargetedSurfaceMounts;
        describeMock.mockResolvedValue({ supported: true, projection: PluginProjectionV2Schema.parse({ v: 2, generation: 42 }) });
        const refresh = loadDaemonMergedProjectionCacheEntry(input);
        await act(async () => { await refresh; });
        const next = await refresh;
        if (next?.kind !== 'ready') throw new Error('Expected refreshed machine projection');
        expect(rendered.getCurrent().projectionInputs).toBe(next.inputs);
        expect(rendered.getCurrent().pluginUiProjection).toBe(next.inputs.pluginUiProjection);
        expect(rendered.getCurrent().preparedTargetedSurfaceMounts).toBe(prepared);
        expect(targetedReadMock).toHaveBeenCalledTimes(1);
    });

    it('keeps exact retained presentation when the target settles before full projection, without granting retained schemas', async () => {
        clearDaemonMergedProjectionCacheForTests();
        const warm = await vi.importActual<typeof import('@/sync/domains/plugins/ui/projectionWarmCache')>('@/sync/domains/plugins/ui/projectionWarmCache');
        const { prepareWarmCacheEncryptionKey } = await import('@/sync/domains/state/warmCacheEncryptionKey');
        await prepareWarmCacheEncryptionKey();
        const machineId = 'machine-retained-before-full';
        const scope = activeAccountLifetime.value!.scope;
        const targetKey = warm.pluginUiProjectionAdmissionTargetKey({ serverId: focusedHomeId, machineId });
        const retainedTarget = PluginUiTargetedContributionsV1Schema.parse({
            ...snapshot('occurrence-a'), points: [{ pointId: 'review-detail', protocols: [{
                protocol: { id: 'review/detail', version: 1 }, contributions: [{
                    contributor: { pluginId: 'acme.review', contributionId: 'detail', occurrenceId: 'review-a', sourceCustody },
                    protocol: { id: 'review/detail', version: 1 }, operations: [], surfaces: [],
                }],
            }] }],
        });
        warm.savePluginUiProjectionAdmissionSnapshot({ scope, targetKey, machineId,
            projection: PluginProjectionV2Schema.parse({ v: 2, generation: 31,
                installedPackagesById: { 'acme.triage': { id: 'acme.triage', displayName: 'Triage', enabled: true,
                    source: { kind: 'local', locator: '/plugins/triage' } } },
                familiesById: { pluginUi: { family: 'pluginUi', entriesById: {
                    'translations:acme.triage': { id: 'translations:acme.triage', pluginId: 'acme.triage', occurrenceId: 'occurrence-a',
                        contributionKind: 'translations', locales: ['en'], bundles: { en: { title: 'Own retained text' } } },
                } } },
            }) });
        warm.savePluginUiProjectionTargetedAdmissionSnapshot({ scope, targetKey, machineId, targetedContributions: retainedTarget });
        targetedReadMock.mockResolvedValue({ supported: true, targetedContributions: retainedTarget, targetedSurfaceMounts: [] });
        const rendered = await renderHook(() => useMountedTargetedContributions({ machineId, serverId: focusedHomeId,
            pluginId: 'acme.triage', mountedOccurrenceId: 'occurrence-a', enabled: true }));
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(rendered.getCurrent().phase).toBe('ready');
        expect(rendered.getCurrent().projectionInputs).toBeNull();
        expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.triage']?.bundles).toEqual({ en: { title: 'Own retained text' } });
        expect(rendered.getCurrent().actionInputSelectionFactsKey.hasPluginProjection).toBe(false);
        targetedReadMock.mockResolvedValue({ supported: true, targetedContributions: { ...retainedTarget,
            target: { ...retainedTarget.target, sourceCustody: { kind: 'development', registeredRootId: 'different-root' } } }, targetedSurfaceMounts: [] });
        const { publishMachineContributionRegistryProjectionInvalidation } = await import('@/sync/ops/machineContributionRegistryProjection');
        await act(async () => { publishMachineContributionRegistryProjectionInvalidation({ machineId, serverId: focusedHomeId }); });
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(rendered.getCurrent().pluginUiProjection).toBeNull();
        expect(rendered.getCurrent().projectionInputs).toBeNull();
        // The preceding fresh response may update retained target admission;
        // retrying it must not relabel the older presentation as that source.
        await act(async () => { publishMachineContributionRegistryProjectionInvalidation({ machineId, serverId: focusedHomeId }); });
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(rendered.getCurrent().pluginUiProjection).toBeNull();
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 32 });
        describeMock.mockResolvedValue({ supported: true, projection });
        await act(async () => { await loadDaemonMergedProjectionCacheEntry({ machineId, serverId: focusedHomeId, accountLifetime: activeAccountLifetime.value }); });
        expect(rendered.getCurrent().projectionInputs?.pluginProjectionV2).toBe(projection);
        expect(rendered.getCurrent().pluginUiProjection?.generation).toBe(32);
        expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId).toEqual({});
    });

    it('follows a reloaded occurrence: asks the machine projection to refresh once instead of failing', async () => {
        const { getMachineContributionRegistryProjectionRevision } = await import('@/sync/ops/machineContributionRegistryProjection');
        targetedReadMock.mockResolvedValue({
            supported: true,
            targetedContributions: snapshot('occurrence-b'),
            targetedSurfaceMounts: [],
        });
        const scope = { machineId: 'machine-reload', serverId: focusedHomeId };
        const revisionBefore = getMachineContributionRegistryProjectionRevision(scope);

        const rendered = await renderHook(() => useMountedTargetedContributions({
            machineId: 'machine-reload',
            serverId: focusedHomeId,
            pluginId: 'acme.triage',
            mountedOccurrenceId: 'occurrence-a',
            enabled: true,
        }));
        await flushHookEffects({ cycles: 3, turns: 2 });

        expect(rendered.getCurrent()).toMatchObject({
            phase: 'ready',
            targetedContributions: snapshot('occurrence-b'),
            failure: null,
        });
        // One invalidation for the (a → b) pair; the re-read it causes returns
        // the same tag and does not publish again.
        expect(getMachineContributionRegistryProjectionRevision(scope)).toBe(revisionBefore + 1);
        expect(targetedReadMock).toHaveBeenCalledTimes(2);
    });

    it('keeps the classified failure reason and the last snapshot through a failed refresh', async () => {
        targetedReadMock
            .mockResolvedValueOnce({
                supported: true,
                targetedContributions: snapshot('occurrence-a'),
                targetedSurfaceMounts: [],
            })
            .mockResolvedValueOnce({ supported: false, reason: 'timeout' });
        const mod = await import('@/sync/ops/machineContributionRegistryProjection');
        const rendered = await renderHook(() => useMountedTargetedContributions({
            machineId: 'machine-timeout',
            serverId: focusedHomeId,
            pluginId: 'acme.triage',
            mountedOccurrenceId: 'occurrence-a',
            enabled: true,
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });
        await act(async () => {
            mod.publishMachineContributionRegistryProjectionInvalidation({
                machineId: 'machine-timeout',
                serverId: focusedHomeId,
            });
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(rendered.getCurrent()).toMatchObject({
            phase: 'failed',
            failure: { reason: 'timeout' },
            targetedContributions: snapshot('occurrence-a'),
        });
    });
});
