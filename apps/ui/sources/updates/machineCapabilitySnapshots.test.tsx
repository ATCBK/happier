import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup, type RenderHookResult } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

// Install the physical transport boundary before importing the real cache owner.
const network = await installSessionOpsNetworkBoundary();
const { useMachinesCapabilitySnapshots } = await import('./machineCapabilitySnapshots');

afterEach(() => standardCleanup());
afterAll(() => network.dispose());

describe('useMachinesCapabilitySnapshots', () => {
    it('keeps unchanged snapshots stable when the requested IDs contain duplicates', async () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        let hook: RenderHookResult<ReturnType<typeof useMachinesCapabilitySnapshots>, void> | undefined;
        let renderError: unknown;
        try {
            try {
                hook = await renderHook(() => useMachinesCapabilitySnapshots('snapshot-home', ['machine-a', 'machine-a', 'machine-b']));
            } catch (error) {
                renderError = error;
            }
            expect(errors.mock.calls.filter(args => args.some(value => String(value).includes('getSnapshot should be cached')))).toEqual([]);
            expect(renderError).toBeUndefined();
            expect(hook).toBeDefined();
            if (!hook) return;
            const snapshot = hook.getCurrent();
            expect([...snapshot.entries()]).toEqual([['machine-a', null], ['machine-b', null]]);
            await hook.rerender();
            expect(hook.getCurrent()).toBe(snapshot);
        } finally {
            await hook?.unmount();
            errors.mockRestore();
        }
    });
});
