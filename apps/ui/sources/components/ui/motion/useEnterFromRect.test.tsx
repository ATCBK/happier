import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

type Probe = { current: ReturnType<typeof import('./rectFlight').useEnterFromRect> | null };

async function renderEnter(origin: { x: number; y: number; width: number; height: number } | null, reducedMotion: boolean) {
    const { useEnterFromRect } = await import('./rectFlight');
    const probe: Probe = { current: null };
    function Harness() {
        probe.current = useEnterFromRect(origin, { reducedMotion });
        return null;
    }
    await renderScreen(<Harness />);
    return probe;
}

describe('useEnterFromRect (MPG-32)', () => {
    it('holds the first frame while an origin waits for its target, then travels to identity', async () => {
        const probe = await renderEnter({ x: 10, y: 400, width: 20, height: 20 }, false);
        // Before the target is measured nothing may paint at the final position.
        expect(probe.current?.ready).toBe(false);
        await act(async () => probe.current!.onTarget({ x: 300, y: 80, width: 240, height: 40 }));
        expect(probe.current?.ready).toBe(true);
    });

    it('applies nothing without an origin, and travels nowhere under reduced motion', async () => {
        expect((await renderEnter(null, false)).current?.ready).toBe(true);
        const reduced = await renderEnter({ x: 10, y: 400, width: 20, height: 20 }, true);
        expect(reduced.current?.ready).toBe(true);
    });
});
