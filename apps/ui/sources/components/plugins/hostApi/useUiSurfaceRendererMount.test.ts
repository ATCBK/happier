import { afterEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import { Platform } from 'react-native';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { RetainedPanelSurface } from '@/components/ui/panels/RetainedPanelSurface';
import { usePluginSurfaceFocusEligibility } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

import { useUiSurfaceRendererMount } from './useUiSurfaceRendererMount';

afterEach(standardCleanup);

function createLifetime() {
    const controller = new AbortController();
    return {
        isCurrent: () => !controller.signal.aborted,
        onRetire: (listener: () => void) => {
            controller.signal.addEventListener('abort', listener);
            return { dispose: () => controller.signal.removeEventListener('abort', listener) };
        },
        retire: () => controller.abort(),
    };
}

describe('physical surface renderer mount', () => {
    it.each(['web', 'ios', 'android'] as const)('keeps a retained %s renderer current across hide/reveal and retires it only on unmount', async platform => {
        const originalPlatform = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
        const lifetime = createLifetime();
        let current: ReturnType<typeof useUiSurfaceRendererMount> | undefined;
        function Renderer() {
            current = useUiSurfaceRendererMount({
                lifetime, interactionEnabled: true, focusEligible: usePluginSurfaceFocusEligibility(), mountKey: 'external-plugin',
            });
            return null;
        }
        const child = React.createElement(Renderer);
        const panel = (active: boolean) => React.createElement(RetainedPanelSurface, { isActive: active, children: child });
        try {
            const screen = await renderScreen(panel(true));
            const first = current!;
            await screen.update(panel(false));
            expect(first.signal.aborted).toBe(false);
            expect(first.isCurrent()).toBe(true);
            expect(first.isFocusEligible()).toBe(false);
            await screen.update(panel(true));
            expect(current!.signal).toBe(first.signal);
            expect(current!.identity).toBe(first.identity);
            expect(first.isFocusEligible()).toBe(true);
            await screen.unmount();
            expect(first.signal.aborted).toBe(true);
            expect(first.isCurrent()).toBe(false);
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
        }
    });

    it('preserves mount identity across presentation changes while checking current focus eligibility', async () => {
        const lifetime = createLifetime();
        const hook = await renderHook(useUiSurfaceRendererMount, {
            initialProps: { lifetime, interactionEnabled: true, focusEligible: true, mountKey: 'document-a' },
        });
        const first = hook.getCurrent();
        expect(first.identity).not.toBeNull();
        expect(first.isFocusEligible()).toBe(true);
        await hook.rerender({ lifetime, interactionEnabled: true, focusEligible: false, mountKey: 'document-a' });
        expect(hook.getCurrent().identity).toBe(first.identity);
        expect(hook.getCurrent().signal).toBe(first.signal);
        expect(first.isFocusEligible()).toBe(false);
        lifetime.retire();
        expect(first.signal.aborted).toBe(true);
        expect(first.isCurrent()).toBe(false);
    });

    it('retires a replaced physical document and the unmounted renderer', async () => {
        const lifetime = createLifetime();
        const hook = await renderHook(useUiSurfaceRendererMount, {
            initialProps: { lifetime, interactionEnabled: true, focusEligible: true, mountKey: 'document-a' },
        });
        const first = hook.getCurrent();
        await hook.rerender({ lifetime, interactionEnabled: true, focusEligible: true, mountKey: 'document-b' });
        const second = hook.getCurrent();
        expect(first.signal.aborted).toBe(true);
        expect(first.isCurrent()).toBe(false);
        expect(second.identity).not.toEqual(first.identity);
        expect(second.isCurrent()).toBe(true);
        await hook.unmount();
        expect(second.signal.aborted).toBe(true);
    });
});
