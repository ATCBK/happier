import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createMachineFixture, createSessionFixture, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { storage } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { publishAppliedActiveServerRuntimeAvailability, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';

const machineRpc = vi.hoisted(() => vi.fn());
// Only the machine transport leaves this deterministic palette/Action owner.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpc }));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { clearDaemonMergedProjectionCacheForTests, loadDaemonMergedProjectionInputs } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { useCommandPalettePluginActionPresentation } = await import('./CommandPaletteProvider');

beforeEach(async () => {
    await homes.reset();
    clearDaemonMergedProjectionCacheForTests();
    machineRpc.mockReset();
});

afterEach(async () => {
    standardCleanup();
    publishAppliedActiveServerRuntimeAvailability(false);
    storage.setState(storage.getInitialState(), true);
    await homes.reset();
});

it('keeps a routed Session Action form on its Home through focused Account rotation, then retires it with its own credentials', async () => {
    const focusedHome = await homes.addHome({ name: 'Focused A', serverUrl: 'https://palette-focused.test', accountId: 'account-a' });
    const routedHome = await homes.addHome({ name: 'Session B', serverUrl: 'https://palette-routed.test', accountId: 'account-b', active: false });
    storage.setState({ profileScope: { serverId: focusedHome, accountId: 'account-a' } });
    publishAppliedActiveServerSnapshot({ serverId: focusedHome, serverUrl: 'https://palette-focused.test', generation: 1 });
    const focusedLifetime = captureActiveServerAccountScopeLifetime();
    expect(focusedLifetime?.scope.accountId).toBe('account-a');
    const machine = createMachineFixture({ id: 'palette-machine-b', active: true, activeAt: Date.now() });
    const session = createSessionFixture({ id: 'palette-session-b', serverId: routedHome, active: true,
        metadata: { machineId: machine.id, path: '/workspace/b', host: 'machine-b' } });
    storage.setState({ sessions: { [session.id]: session },
        machineListByServerId: { [routedHome]: [machine] }, machineListStatusByServerId: { [routedHome]: 'idle' } });
    let projection = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
        projection: { v: 2, generation: 13,
            installedPackagesById: { 'acme.palette': { id: 'acme.palette', displayName: 'Palette', enabled: true,
                source: { kind: 'local', locator: '/plugins/palette' } } },
            actionsById: { 'acme.palette/review': { id: 'review', pluginId: 'acme.palette', occurrenceId: 'review-b',
                title: 'Review B', scopes: ['session'], surfaces: ['ui'], placementBindings: ['commandPalette'],
                dangerLevel: 'safe', execution: { target: 'daemon' }, available: true,
                inputHints: { title: 'Review B', submitLabel: 'Review', fields: [{ path: 'reason', title: 'Reason', widget: 'textarea', required: true }] } } },
        } });
    machineRpc.mockImplementation(async request => {
        if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return projection;
        throw new Error(`Unexpected palette machine method: ${request.method}`);
    });
    const rendered = await renderHook(() => useCommandPalettePluginActionPresentation(session.id));
    await vi.waitFor(() => expect(rendered.getCurrent()?.controller.list({ placement: 'commandPalette', scope: 'session' })).toHaveLength(1));
    expect(machineRpc).toHaveBeenCalledWith(expect.objectContaining({
        machineId: machine.id, serverId: routedHome, accountId: 'account-b',
        method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
    }));
    const bindings = await renderHook(() => useServerCredentialAccountScopeBindings([routedHome]));
    await flushHookEffects();
    const lifetime = bindings.getCurrent().values().next().value;
    if (!lifetime) throw new Error('Routed credentials must have a live Account binding');
    const publish = async (next: typeof projection) => {
        projection = next;
        await act(async () => { await loadDaemonMergedProjectionInputs({ machineId: machine.id,
            serverId: routedHome, accountLifetime: lifetime, staleMs: 0 }); });
        await flushHookEffects();
    };
    const noise = (arrival: number) => DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
        ...projection, projection: { ...projection.projection, generation: 13 + arrival,
            agentsById: { review: { id: 'review', title: `Unrelated Agent ${arrival}`,
                identity: { pluginId: 'acme.agent', localId: 'review' },
                capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } } },
        },
    });
    const presentation = rendered.getCurrent()!;
    const action = presentation.controller.list({ placement: 'commandPalette', scope: 'session' })[0]!;
    const opened = await presentation.controller.open(action);
    expect(opened.kind).toBe('form');
    if (opened.kind !== 'form') throw new Error('Expected the routed Action form');
    let form = opened.form;
    form.replaceInput({ reason: 'Private draft for B' });
    for (let arrival = 1; arrival <= 20; arrival++) await publish(noise(arrival));
    expect(form.isRetired()).toBe(false);
    expect(form.getInput()).toEqual({ reason: 'Private draft for B' });
    expect(form.pickerContext).toMatchObject({ serverId: routedHome, machineId: machine.id, sessionId: session.id });
    const openCurrent = async () => {
        const current = rendered.getCurrent()!;
        const action = current.controller.list({ placement: 'commandPalette', scope: 'session' })[0]!;
        const next = await current.controller.open(action);
        if (next.kind !== 'form') throw new Error('Current Action must open its form');
        next.form.replaceInput({ reason: 'Private draft for B' });
        return next.form;
    };
    await publish(DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ ...projection,
        projection: { ...projection.projection, actionsById: { 'acme.palette/review': {
            ...projection.projection.actionsById['acme.palette/review']!, title: 'Edited review',
        } } },
    }));
    expect(form.isRetired()).toBe(true);
    form = await openCurrent();
    await publish(DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ ...projection,
        projection: { ...projection.projection, installedPackagesById: { 'acme.palette': {
            ...projection.projection.installedPackagesById['acme.palette']!, enabled: false,
        } } },
    }));
    expect(form.isRetired()).toBe(true);
    expect(rendered.getCurrent()!.controller.list({ placement: 'commandPalette', scope: 'session' })).toHaveLength(0);
    await publish(DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ ...projection,
        projection: { ...projection.projection, installedPackagesById: { 'acme.palette': {
            ...projection.projection.installedPackagesById['acme.palette']!, enabled: true,
        } } },
    }));
    form = await openCurrent();
    await publish(DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ ...projection,
        projection: { ...projection.projection, actionsById: { 'acme.palette/review': {
            ...projection.projection.actionsById['acme.palette/review']!, occurrenceId: 'review-replacement',
        } } },
    }));
    expect(form.isRetired()).toBe(true);
    form = await openCurrent();

    // Focus observation retirement is part of A's rotation, not B's credential lifetime.
    await act(async () => {
        publishAppliedActiveServerRuntimeAvailability(false);
        await homes.switchAccount(focusedHome, 'account-a-next');
    });
    expect(focusedLifetime?.isCurrent()).toBe(false);
    await rendered.rerender();
    await flushHookEffects();
    expect(form.isRetired()).toBe(false);
    expect(form.getInput()).toEqual({ reason: 'Private draft for B' });
    expect(presentation.signal.aborted).toBe(false);

    await act(async () => { await homes.switchAccount(routedHome, 'account-b-next'); });
    await flushHookEffects();
    expect(form.isRetired()).toBe(true);
    expect(form.getInput()).toEqual({});
    expect(presentation.signal.aborted).toBe(true);
});
