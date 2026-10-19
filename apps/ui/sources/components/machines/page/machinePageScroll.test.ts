import { describe, expect, it } from 'vitest';

import { createMachinePageScrollMemory, machinePageScrollKey } from './machinePageScroll';

describe('machine page scroll on push', () => {
    it('opens a pushed page (Activity) at its top, and returns to where the tab was left', () => {
        const memory = createMachinePageScrollMemory();
        const guard = { id: 'guard' } as const;
        const activity = { id: 'guard', page: 'activity' } as const;
        memory.record(machinePageScrollKey(guard), 1306);
        expect(memory.arrive(activity)).toBe(0);
        memory.record(machinePageScrollKey(activity), 420);
        expect(memory.arrive(guard)).toBe(1306);
        // Another tab's root never inherits the offset of the tab it replaces.
        expect(memory.arrive({ id: 'storage' })).toBe(0);
        // A sort is view state of the same page, not a new one.
        expect(machinePageScrollKey({ id: 'processes', sort: 'cpu' })).toBe(machinePageScrollKey({ id: 'processes', sort: 'memory' }));
    });
});
