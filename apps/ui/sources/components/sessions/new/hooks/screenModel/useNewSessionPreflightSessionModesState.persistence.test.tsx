import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { installNewSessionPreflightHarness } from '@/dev/testkit/harness/newSessionPreflightHarness';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type ProbeModesResult = Readonly<{
  agentId?: string;
  source?: 'dynamic' | 'static';
  availableModes: Array<{ id: string; name: string; description?: string }>;
}>;

type ProbeResponse = Readonly<{
  ok: true;
  result: ProbeModesResult;
}>;

const machineCapabilitiesInvokeMock = vi.fn(async (_machineId: any, _request: any, _options: any): Promise<ProbeResponse> => ({
  ok: true as const,
  result: { availableModes: [{ id: 'plan', name: 'Plan' }] },
}));

let browser = await installBrowserRuntimeForTests({ url: 'https://new-session-preflight.test/' });
let preflight = await installNewSessionPreflightHarness(machineCapabilitiesInvokeMock, { installBrowser: false });
const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
async function reloadOwnerGraph() {
  await preflight.dispose();
  vi.resetModules();
  preflight = await installNewSessionPreflightHarness(machineCapabilitiesInvokeMock, { installBrowser: false });
}
beforeEach(async () => {
  browser.restore();
  browser = await installBrowserRuntimeForTests({ url: 'https://new-session-preflight.test/' });
  await preflight.reset();
  const { resetDynamicSessionModeProbeCacheForTests } = await import('@/sync/domains/sessionModes/dynamicSessionModeProbeCache');
  resetDynamicSessionModeProbeCacheForTests();
});
afterEach(standardCleanup);
afterAll(async () => {
  await preflight.dispose();
  browser.restore();
});

describe('useNewSessionPreflightSessionModesState (persistence)', () => {
  it('hydrates cached results across module reloads (app restarts)', async () => {
    machineCapabilitiesInvokeMock.mockClear();

    const { useNewSessionPreflightSessionModesState } = await import('./useNewSessionPreflightSessionModesState');

    const first = await renderHook(() => useNewSessionPreflightSessionModesState({
        backendTarget: { kind: 'backend', backendId: 'opencode' },
        selectedMachineId: 'machine-1',
        capabilityServerId: preflight.serverId,
        cwd: '/repo',
    }));
    await waitForHomeGovernance(async () => {
      await flushHookEffects();
      expect(first.getCurrent().preflightModes).not.toBeNull();
    });
    const initialModes = first.getCurrent().preflightModes;
    await first.unmount();

    await reloadOwnerGraph();

    const { useNewSessionPreflightSessionModesState: useNewSessionPreflightSessionModesState2 } = await import('./useNewSessionPreflightSessionModesState');

    const reloaded = await renderHook(() => useNewSessionPreflightSessionModesState2({
        backendTarget: { kind: 'backend', backendId: 'opencode' },
        selectedMachineId: 'machine-1',
        capabilityServerId: preflight.serverId,
        cwd: '/repo',
    }));
    expect(reloaded.getCurrent().preflightModes).toEqual(initialModes);
    await reloaded.unmount();

    expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(1);
  });

  it('does not persist static fallback probe results across module reloads', async () => {
    machineCapabilitiesInvokeMock.mockClear();

    machineCapabilitiesInvokeMock.mockResolvedValue({
      ok: true as const,
      result: { source: 'static', availableModes: [{ id: 'plan', name: 'Plan' }] },
    });

    const { useNewSessionPreflightSessionModesState } = await import('./useNewSessionPreflightSessionModesState');

    const first = await renderHook(() => useNewSessionPreflightSessionModesState({
        backendTarget: { kind: 'backend', backendId: 'opencode' },
        selectedMachineId: 'machine-1',
        capabilityServerId: preflight.serverId,
        cwd: '/repo',
    }));
    await waitForHomeGovernance(async () => {
      await flushHookEffects();
      expect(first.getCurrent().preflightModes).not.toBeNull();
    });
    await first.unmount();

    await reloadOwnerGraph();

    const { useNewSessionPreflightSessionModesState: useNewSessionPreflightSessionModesState2 } = await import('./useNewSessionPreflightSessionModesState');

    const reloaded = await renderHook(() => useNewSessionPreflightSessionModesState2({
        backendTarget: { kind: 'backend', backendId: 'opencode' },
        selectedMachineId: 'machine-1',
        capabilityServerId: preflight.serverId,
        cwd: '/repo',
    }));
    await waitForHomeGovernance(async () => {
      await flushHookEffects();
      expect(reloaded.getCurrent().preflightModes).not.toBeNull();
    });
    await reloaded.unmount();

    expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(2);
  });
});
