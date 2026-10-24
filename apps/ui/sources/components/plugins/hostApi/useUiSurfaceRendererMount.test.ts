import { afterEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import { Platform } from 'react-native';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createDeferred, renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { RetainedPanelSurface } from '@/components/ui/panels/RetainedPanelSurface';
import { usePluginSurfaceFocusEligibility } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

import { useUiSurfaceRendererMount } from './useUiSurfaceRendererMount';

afterEach(standardCleanup);

function createLifetime() {
    const controller = new AbortController();
    const listeners = new Set<() => void>();
    return {
        isCurrent: () => !controller.signal.aborted,
        onRetire: (listener: () => void) => {
            listeners.add(listener);
            controller.signal.addEventListener('abort', listener);
            return { dispose: () => { listeners.delete(listener); controller.signal.removeEventListener('abort', listener); } };
        },
        retire: () => controller.abort(),
        readRetirementCount: () => listeners.size,
    };
}

describe('physical surface renderer mount', () => {
    it.each(['reveal', 'retire', 'unmount'] as const)('keeps Suspense detachment separate from physical %s and observes actual retirement', async ending => {
        const lifetime = createLifetime();
        const suspended = createDeferred<void>();
        let hidden = false;
        let current: ReturnType<typeof useUiSurfaceRendererMount> | undefined;
        function Renderer() {
            current = useUiSurfaceRendererMount({ lifetime, interactionEnabled: true, focusEligible: true });
            return null;
        }
        function Gate(): null {
            if (hidden) throw suspended.promise;
            return null;
        }
        const render = () => React.createElement(React.Suspense, { fallback: React.createElement('View', { testID: 'suspended' }) },
            React.createElement(Renderer), React.createElement(Gate));
        const screen = await renderScreen(render());
        const mounted = current!;
        hidden = true;
        await screen.update(render());
        expect(screen.findByTestId('suspended')).toBeTruthy();
        expect(lifetime.isCurrent()).toBe(true);
        if (ending !== 'reveal') {
            if (ending === 'retire') lifetime.retire();
            else await screen.unmount();
            expect(mounted.signal.aborted).toBe(true);
            expect(mounted.isCurrent()).toBe(false);
            if (ending === 'retire') await screen.unmount();
            expect(lifetime.readRetirementCount()).toBe(0);
            await React.act(async () => { suspended.resolve(); });
            return;
        }
        expect(lifetime.readRetirementCount()).toBe(1);
        hidden = false;
        await React.act(async () => { suspended.resolve(); });
        await screen.update(render());
        expect(screen.findByTestId('suspended')).toBeNull();
        expect(current!.signal).toBe(mounted.signal);
        expect(mounted.isCurrent()).toBe(true);
        expect(mounted.signal.aborted).toBe(false);
        await screen.unmount();
        expect(mounted.isCurrent()).toBe(false);
        expect(mounted.signal.aborted).toBe(true);
        expect(lifetime.readRetirementCount()).toBe(0);
    });

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
