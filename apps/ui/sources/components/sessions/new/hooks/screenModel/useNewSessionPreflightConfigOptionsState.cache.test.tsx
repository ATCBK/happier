import { installNewSessionPreflightHarness } from '@/dev/testkit/harness/newSessionPreflightHarness';
import { standardCleanup } from '@/dev/testkit';
import * as React from 'react';
import { describe, expect, it, vi, afterAll, afterEach, beforeEach } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import { flushHookEffects, renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const capabilityRpc = vi.fn(async (_machineId: any, _request: any, _options: any) => ({
        ok: true as const,
        result: {
            agentId: 'codex',
            configOptions: [
                { id: 'opt1', name: 'Option 1', type: 'boolean', currentValue: true },
            ],
            source: 'dynamic',
        },
    }));

const preflight = await installNewSessionPreflightHarness((...args) => capabilityRpc(...args));
const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const probeCache = await import('@/sync/domains/sessionControl/dynamicConfigOptionsProbeCache');
beforeEach(async () => {
    await preflight.reset();
    probeCache.resetDynamicConfigOptionsProbeCacheForTests();
});
afterEach(standardCleanup);
afterAll(() => preflight.dispose());

describe('useNewSessionPreflightConfigOptionsState (cache)', () => {
    it('does not re-probe when a fresh config options result is cached', async () => {

        capabilityRpc.mockClear();

        const { resetDynamicConfigOptionsProbeCacheForTests } = await import('@/sync/domains/sessionControl/dynamicConfigOptionsProbeCache');
        resetDynamicConfigOptionsProbeCacheForTests();

        const { useNewSessionPreflightConfigOptionsState } = await import('./useNewSessionPreflightConfigOptionsState');

        let latest: ReturnType<typeof useNewSessionPreflightConfigOptionsState> | undefined;
        const readLatest = () => {
            if (!latest) throw new Error('Expected preflight config options to render');
            return latest;
        };
        function Harness() {
            latest = useNewSessionPreflightConfigOptionsState({
                backendTarget: { kind: 'backend', backendId: 'codex' },
                selectedMachineId: 'machine-1',
                capabilityServerId: preflight.serverId,
                cwd: '/repo',
            } as any);
            return null;
        }

        let root1!: renderer.ReactTestRenderer;
        root1 = (await renderScreen(React.createElement(Harness))).tree;
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(readLatest().configOptions).not.toBeNull();
        });
        expect(readLatest().configOptions?.map(option => option.id)).toEqual(['opt1']);
        await act(async () => {
            root1.unmount();
        });

        let root2!: renderer.ReactTestRenderer;
        root2 = (await renderScreen(React.createElement(Harness))).tree;
        expect(readLatest().configOptions?.map(option => option.id)).toEqual(['opt1']);
        await act(async () => {
            root2.unmount();
        });

        expect(capabilityRpc).toHaveBeenCalledTimes(1);
    });

    it('does not attempt config-options probing for plugin backend targets', async () => {

        capabilityRpc.mockClear();

        const { resetDynamicConfigOptionsProbeCacheForTests } = await import('@/sync/domains/sessionControl/dynamicConfigOptionsProbeCache');
        resetDynamicConfigOptionsProbeCacheForTests();

        const { useNewSessionPreflightConfigOptionsState } = await import('./useNewSessionPreflightConfigOptionsState');

        function Harness() {
            useNewSessionPreflightConfigOptionsState({
                backendTarget: { kind: 'backend', backendId: 'acme.review.backend' },
                selectedMachineId: 'machine-1',
                capabilityServerId: preflight.serverId,
                cwd: '/repo',
            } as any);
            return null;
        }

        let root!: renderer.ReactTestRenderer;
        root = (await renderScreen(React.createElement(Harness))).tree;
        await act(async () => {
            root.unmount();
        });

        expect(capabilityRpc).toHaveBeenCalledTimes(0);
    });

    it('keeps config-options probing idle while the selected Agent Settings record loads', async () => {

        capabilityRpc.mockClear();
        const { resetDynamicConfigOptionsProbeCacheForTests } = await import('@/sync/domains/sessionControl/dynamicConfigOptionsProbeCache');
        resetDynamicConfigOptionsProbeCacheForTests();
        const { useNewSessionPreflightConfigOptionsState } = await import('./useNewSessionPreflightConfigOptionsState');

        function Harness() {
            const result = useNewSessionPreflightConfigOptionsState({
                backendTarget: { kind: 'backend', backendId: 'acme.review.backend' },
                runtimeCarrierAgentId: 'acme.review/provider',
                selectedMachineId: 'machine-1',
                capabilityServerId: preflight.serverId,
                cwd: '/repo',
                enabled: false,
            } as any);
            expect(result.configOptions).toBeNull();
            expect(result.probe.phase).toBe('idle');
            return null;
        }

        let root!: renderer.ReactTestRenderer;
        root = (await renderScreen(React.createElement(Harness))).tree;
        await act(async () => {
            root.unmount();
        });
        expect(capabilityRpc).toHaveBeenCalledTimes(0);
    });
});
