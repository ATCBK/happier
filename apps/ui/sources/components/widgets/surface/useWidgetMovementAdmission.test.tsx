import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { useEntityDragDropRuntime } from '@/components/ui/treeDragDrop';
import type { WidgetEntityMovementPort } from '@/sync/ops/actions/widgetEntityMovement';

afterEach(() => standardCleanup());

const scope = { serverId: 'home-a', accountId: 'account-a' };
const surface = { ...scope, owner: { kind: 'home' as const } };

// The movement read is the Action executor's (a host boundary); how often the hook asks for it is the hook's own contract.
it('asks for a destination\'s movement admission once per carry, however many pointer steps and refreshes follow', async () => {
    const { useWidgetMovementAdmission } = await import('./useWidgetMovementAdmission');
    const runtime = useEntityDragDropRuntime();
    const ref = { surface, instanceId: 'section-a' };
    const readAdmission = vi.fn<WidgetEntityMovementPort['readAdmission']>(async () => ({
        status: 'ready', ref, instance: null, destination: surface,
        sourceItem: { kind: 'widget', instance: { v: 1, id: 'section-a', definition: { kind: 'builtin', id: 'x' }, bindings: {} } as never, size: 'medium' } as never,
    }));
    const port: WidgetEntityMovementPort = { readAdmission, execute: async () => ({ status: 'applied' }) };
    const basis = {};
    const hook = await renderHook(() => useWidgetMovementAdmission(surface, basis, port));
    const retire = runtime.registerSource({ id: 'section-a', scope, isCurrent: () => true,
        getItem: () => ({ kind: 'home-section', scope, sectionId: 'section-a' }) });
    try {
        let carry!: NonNullable<ReturnType<typeof runtime.begin>>;
        await act(async () => { carry = runtime.begin('section-a')!; });
        await act(async () => { await Promise.resolve(); });
        for (let y = 0; y < 40; y++) {
            await act(async () => { carry.move({ x: 10, y }); runtime.refresh(); await Promise.resolve(); });
        }
        expect(readAdmission).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().sourceRef).toEqual(ref);
        await act(async () => { carry.cancel(); });
    } finally { retire(); await hook.unmount(); }
});
