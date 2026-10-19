import { installNewSessionPreflightHarness } from '@/dev/testkit/harness/newSessionPreflightHarness';
import { standardCleanup } from '@/dev/testkit';
import * as React from 'react';
import { describe, expect, it, vi, afterAll, afterEach, beforeEach } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const capabilityRpc = vi.fn();
const preflight = await installNewSessionPreflightHarness((...args) => capabilityRpc(...args));
const probeCache = await import('@/sync/domains/sessionModes/dynamicSessionModeProbeCache');
beforeEach(async () => {
    await preflight.reset();
    probeCache.resetDynamicSessionModeProbeCacheForTests();
});
afterEach(standardCleanup);
afterAll(() => preflight.dispose());

describe('useNewSessionPreflightSessionModesState (installed Agent)', () => {
    it('probes session modes for an installed Agent that has no bundled core', async () => {
        // `sessionModes` exists only in the generated bundled entries, so an
        // installed Session Agent has no bundled core to declare an ACP mode
        // kind. Requiring one makes the mode probe structurally unreachable for
        // every installed Agent; an Agent with no bundled declaration probes
        // through its own contribution, exactly as the models probe does.

        const capabilityRpc = vi.fn(async (_machineId: string, _request: unknown) => ({
                ok: true as const,
                result: { availableModes: [{ id: 'plan', name: 'Plan' }] },
            }));
        preflight.setCapabilityResponder(capabilityRpc);

        const { useNewSessionPreflightSessionModesState } = await import('./useNewSessionPreflightSessionModesState');

        function Harness() {
            useNewSessionPreflightSessionModesState({
                backendTarget: { kind: 'backend', backendId: 'acme.review' },
                runtimeCarrierAgentId: 'acme.review',
                selectedMachineId: 'machine-1',
                capabilityServerId: preflight.serverId,
                cwd: '/repo',
            } as any);
            return null;
        }

        let root!: renderer.ReactTestRenderer;
        root = (await renderScreen(React.createElement(Harness))).tree;
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
            root.unmount();
        });

        expect(capabilityRpc).toHaveBeenCalledTimes(1);
        const firstCall = capabilityRpc.mock.calls[0] as unknown as [unknown, unknown] | undefined;
        expect(firstCall?.[1]).toMatchObject({
            id: 'cli.acme.review',
            method: 'probeModes',
        });
    });

    it('still refuses the mode probe for a bundled Agent whose core declares static modes', async () => {
        // The bundled declaration stays authoritative: a bundled Agent with
        // static modes must not start probing just because the unknown-core
        // path opened up.

        const capabilityRpc = vi.fn(async (_machineId: string, _request: unknown) => ({
                ok: true as const,
                result: { availableModes: [{ id: 'plan', name: 'Plan' }] },
            }));
        preflight.setCapabilityResponder(capabilityRpc);

        const { useNewSessionPreflightSessionModesState } = await import('./useNewSessionPreflightSessionModesState');

        function Harness() {
            useNewSessionPreflightSessionModesState({
                backendTarget: { kind: 'backend', backendId: 'claude' },
                selectedMachineId: 'machine-1',
                capabilityServerId: preflight.serverId,
                cwd: '/repo',
            } as any);
            return null;
        }

        let root!: renderer.ReactTestRenderer;
        root = (await renderScreen(React.createElement(Harness))).tree;
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
            root.unmount();
        });

        expect(capabilityRpc).toHaveBeenCalledTimes(0);
    });
});
