import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineProtocolObject } from '@happier-dev/plugin-sdk/protocol';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import { flushHookEffects, renderHook } from '@/dev/testkit';

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

vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    captureActiveServerAccountScopeLifetime: () => activeAccountLifetime.value,
}));

vi.mock('@/sync/domains/plugins/ui/projectionWarmCache', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/domains/plugins/ui/projectionWarmCache')>()),
    savePluginUiProjectionTargetedAdmissionSnapshot: vi.fn(),
}));

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

describe('useMountedTargetedContributions', () => {
    beforeEach(async () => {
        targetedReadMock.mockReset();
        describeMock.mockReset();
        activeAccountLifetime.value = Object.freeze({
            scope: Object.freeze({ serverId: 'server-1', accountId: 'account-a' }),
            isCurrent: () => true,
            onRetire: () => Object.freeze({ dispose: () => {} }),
        });
    });

    it('reads only the target slice and prepares its mounts', async () => {
        targetedReadMock.mockResolvedValue({
            supported: true,
            targetedContributions: snapshot('occurrence-a'),
            targetedSurfaceMounts: [mount('occurrence-a')],
        });
        const { useMountedTargetedContributions } = await import('./mountedTargetedContributions');

        const rendered = await renderHook(() => useMountedTargetedContributions({
            machineId: 'machine-1',
            serverId: 'server-1',
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
        expect(targetedReadMock).toHaveBeenCalledWith('machine-1', expect.objectContaining({ serverId: 'server-1', pluginId: 'acme.triage' }));
        // The mount never asks for the machine-wide projection itself.
        expect(describeMock).not.toHaveBeenCalled();
    });

    it('publishes exact ready model inputs with the target and updates them from the existing machine publisher', async () => {
        clearDaemonMergedProjectionCacheForTests();
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 41 });
        describeMock.mockResolvedValue({ supported: true, projection });
        const input = { machineId: 'machine-published', serverId: 'server-1', accountLifetime: activeAccountLifetime.value };
        const first = await loadDaemonMergedProjectionCacheEntry(input);
        if (first?.kind !== 'ready') throw new Error('Expected admitted machine projection');
        targetedReadMock.mockResolvedValue({ supported: true, targetedContributions: snapshot('occurrence-a'), targetedSurfaceMounts: [mount('occurrence-a')] });
        const { useMountedTargetedContributions } = await import('./mountedTargetedContributions');
        const rendered = await renderHook(() => useMountedTargetedContributions({
            machineId: input.machineId, serverId: input.serverId, pluginId: 'acme.triage', mountedOccurrenceId: 'occurrence-a', enabled: true,
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(rendered.getCurrent().projectionInputs).toBe(first.inputs);
        expect(rendered.getCurrent().pluginUiProjection).toBe(first.inputs.pluginUiProjection);
        const prepared = rendered.getCurrent().preparedTargetedSurfaceMounts;
        describeMock.mockResolvedValue({ supported: true, projection: PluginProjectionV2Schema.parse({ v: 2, generation: 42 }) });
        let next: Awaited<ReturnType<typeof loadDaemonMergedProjectionCacheEntry>> = null;
        await act(async () => { next = await loadDaemonMergedProjectionCacheEntry(input); });
        if (next!?.kind !== 'ready') throw new Error('Expected refreshed machine projection');
        expect(rendered.getCurrent().projectionInputs).toBe(next!.inputs);
        expect(rendered.getCurrent().pluginUiProjection).toBe(next!.inputs.pluginUiProjection);
        expect(rendered.getCurrent().preparedTargetedSurfaceMounts).toBe(prepared);
        expect(targetedReadMock).toHaveBeenCalledTimes(1);
    });

    it('follows a reloaded occurrence: asks the machine projection to refresh once instead of failing', async () => {
        const { getMachineContributionRegistryProjectionRevision } = await import('@/sync/ops/machineContributionRegistryProjection');
        targetedReadMock.mockResolvedValue({
            supported: true,
            targetedContributions: snapshot('occurrence-b'),
            targetedSurfaceMounts: [],
        });
        const { useMountedTargetedContributions } = await import('./mountedTargetedContributions');
        const scope = { machineId: 'machine-reload', serverId: 'server-1' };
        const revisionBefore = getMachineContributionRegistryProjectionRevision(scope);

        const rendered = await renderHook(() => useMountedTargetedContributions({
            machineId: 'machine-reload',
            serverId: 'server-1',
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
        const { useMountedTargetedContributions } = await import('./mountedTargetedContributions');

        const rendered = await renderHook(() => useMountedTargetedContributions({
            machineId: 'machine-timeout',
            serverId: 'server-1',
            pluginId: 'acme.triage',
            mountedOccurrenceId: 'occurrence-a',
            enabled: true,
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });
        await act(async () => {
            mod.publishMachineContributionRegistryProjectionInvalidation({
                machineId: 'machine-timeout',
                serverId: 'server-1',
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
