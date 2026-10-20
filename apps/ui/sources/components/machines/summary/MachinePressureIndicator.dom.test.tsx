/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

// Keep the real Animated subscription: the host-renderer stub cannot expose
// updates sent to an already mounted Animated.View during another render.
vi.mock('react-native', async () => await vi.importActual('react-native-web'));

import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';
import { MachinePressureIndicator } from './MachinePressureIndicator';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('changes an attached pressure animation without updating another component during render', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const renderPressure = async (level: 'calm' | 'elevated' | 'critical') => {
        await act(async () => {
            const tone = level === 'critical' ? 'crit' : level === 'elevated' ? 'warn' : 'calm';
            root.render(<MachinePressureIndicator level={level} tone={tone} size="large" testID="pressure" />);
        });
    };
    try {
        setReducedMotionPreferenceOverride(false);
        await renderPressure('calm');
        await renderPressure('elevated');
        // A second transition has a live Animated.View subscribed to progress.
        await renderPressure('critical');
        expect(container.querySelector('[data-testid="pressure"]')?.getAttribute('aria-label')).toContain('Critical');
        await act(async () => { setReducedMotionPreferenceOverride(true); });
        await renderPressure('calm');
        expect(errors.mock.calls.filter(args => String(args[0]).includes('Cannot update a component'))).toEqual([]);
    } finally {
        await act(async () => { root.unmount(); setReducedMotionPreferenceOverride(null); });
        container.remove();
        errors.mockRestore();
    }
});
