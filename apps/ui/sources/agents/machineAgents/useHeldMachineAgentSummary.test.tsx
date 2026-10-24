import { afterEach, expect, it } from 'vitest';
import type { MachineAgentInventoryItem } from '@happier-dev/protocol/capabilities';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { serverAccountScopedResourceKey } from '@/sync/domains/scope/serverAccountScope';
import { machineAgentInventoryStore } from './machineAgentInventoryStore';
import { useHeldMachineAgentSummary } from './useHeldMachineAgentSummary';

afterEach(standardCleanup);

it('keeps a mounted row local, reads current held facts on reopening, and drops another Account immediately', async () => {
    const scope = { serverId: 'held-summary-home', accountId: 'held-summary-account' };
    const machineIds = Array.from({ length: 139 }, (_, i) => `m-${i}`);
    const fact: MachineAgentInventoryItem = { agentId: 'custom-acp', definitionId: 'one', title: 'One', installed: true,
        version: '2.1.4', latestVersion: null, update: { supported: false, command: null },
        signIn: { status: 'signedIn', loginSupport: 'status_only' }, platform: { supported: true },
        install: { available: false, mode: 'manual', sizeBytes: null, guideUrl: null }, dependencies: [] };
    const publish = (machineId: string, version: string) => machineAgentInventoryStore.publish(
        serverAccountScopedResourceKey(scope, 'machine-agents', machineId),
        { status: 'ready', items: [fact, { ...fact, definitionId: 'two', version }], lastCheckedAt: 1 });
    for (const id of machineIds) publish(id, '1');
    let renders = 0;
    const hook = await renderHook(({ enabled, accountId }: { enabled: boolean; accountId: string }) => {
        renders++;
        return useHeldMachineAgentSummary({ scope: { ...scope, accountId }, machineIds, agentId: 'custom-acp', definitionId: 'one', enabled });
    }, { initialProps: { enabled: true, accountId: scope.accountId } });
    expect(hook.getCurrent()).toEqual({ machineCount: 139, versions: ['2.1.4'], unknownVersionCount: 0, complete: true });
    const settledRenders = renders;
    await act(async () => { for (const id of machineIds) publish(id, '2'); });
    expect(renders).toBe(settledRenders);
    await hook.rerender({ enabled: false, accountId: scope.accountId });
    expect(hook.getCurrent().machineCount).toBe(0);
    const inactiveRenders = renders;
    await act(async () => {
        machineAgentInventoryStore.publish(serverAccountScopedResourceKey(scope, 'machine-agents', machineIds[0]!),
            { status: 'ready', items: [{ ...fact, version: '3' }], lastCheckedAt: 2 });
    });
    expect(renders).toBe(inactiveRenders);
    await hook.rerender({ enabled: true, accountId: scope.accountId });
    expect(hook.getCurrent().versions).toEqual(['2.1.4', '3']);
    await hook.rerender({ enabled: true, accountId: 'another-account' });
    expect(hook.getCurrent().machineCount).toBe(0);
    await hook.unmount();
});

it('counts published installs on cold machines and exposes unknown versions and incomplete coverage', async () => {
    const scope = { serverId: 'published-summary-home', accountId: 'published-summary-account' };
    const publishedByMachineId = new Map([['cold', { checkedAt: 1, installedAgentIds: ['claude'] }]]);
    const hook = await renderHook(() => useHeldMachineAgentSummary({ scope, machineIds: ['cold'], agentId: 'claude',
        publishedByMachineId }));
    expect(hook.getCurrent()).toEqual({ machineCount: 1, versions: [], unknownVersionCount: 1, complete: true });
    await hook.unmount();
    const missing = await renderHook(() => useHeldMachineAgentSummary({ scope, machineIds: ['unobserved'], agentId: 'claude' }));
    expect(missing.getCurrent()).toEqual({ machineCount: 0, versions: [], unknownVersionCount: 0, complete: false });
    await missing.unmount();
});
