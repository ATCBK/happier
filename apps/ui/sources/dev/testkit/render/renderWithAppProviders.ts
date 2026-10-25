import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import * as safeAreaContext from 'react-native-safe-area-context';

import { registerStandardCleanupTarget, unregisterStandardCleanupTarget } from '../cleanup/standardCleanup';
import { flushHookEffects, type FlushHookEffectsOptions } from '../hooks/flushHookEffects';

export type RenderWithAppProvidersOptions = Readonly<{
    wrapper?: React.ComponentType<React.PropsWithChildren>;
    flushOptions?: FlushHookEffectsOptions;
    createNodeMock?: (element: Readonly<{ type: React.ReactElement['type']; props: Record<string, unknown> }>) => unknown;
}>;

export type RenderWithAppProvidersResult = Readonly<{
    tree: renderer.ReactTestRenderer;
    subscribe: (notify: () => void) => () => void;
    update: (element: React.ReactElement) => Promise<void>;
    unmount: () => Promise<void>;
}>;

function applyWrapper(
    element: React.ReactElement,
    wrapper?: React.ComponentType<React.PropsWithChildren>,
): React.ReactElement {
    const safeAreaInsets = { top: 0, left: 0, right: 0, bottom: 0 };
    const safeAreaModule = safeAreaContext as unknown as Record<string, unknown>;
    const SafeAreaInsetsContext =
        safeAreaModule
        && typeof safeAreaModule === 'object'
        && 'SafeAreaInsetsContext' in safeAreaModule
            ? (safeAreaModule as { SafeAreaInsetsContext: unknown }).SafeAreaInsetsContext
            : null;

    const wrapped = SafeAreaInsetsContext && typeof SafeAreaInsetsContext === 'object' && 'Provider' in SafeAreaInsetsContext
        ? React.createElement(
            (SafeAreaInsetsContext as unknown as { Provider: React.ComponentType<any> }).Provider,
            { value: safeAreaInsets },
            element,
        )
        : element;

    if (!wrapper) return wrapped as unknown as React.ReactElement;
    return React.createElement(wrapper, null, wrapped);
}

export async function renderWithAppProviders(
    element: React.ReactElement,
    options: RenderWithAppProvidersOptions = {},
): Promise<RenderWithAppProvidersResult> {
    let tree!: renderer.ReactTestRenderer;
    const listeners = new Set<() => void>();
    const onCommit = () => { for (const notify of listeners) notify(); };
    const renderElement = (value: React.ReactElement) => {
        // Observe provider-owned siblings such as dialogs too. Root StrictMode
        // must remain outside the profiler for React 19's initial effect replay.
        const strict = options.wrapper === React.StrictMode;
        const profiled = React.createElement(
            React.Profiler,
            { id: 'testkit.screen', onRender: onCommit },
            applyWrapper(value, strict ? undefined : options.wrapper),
        );
        return strict ? React.createElement(React.StrictMode, null, profiled) : profiled;
    };
    const rendererOptions = options.createNodeMock
        // React supplies an object props bag; the SDK erases it to unknown in React 19.
        ? { createNodeMock: options.createNodeMock as renderer.TestRendererOptions['createNodeMock'] }
        : undefined;

    await act(async () => {
        tree = renderer.create(renderElement(element), rendererOptions);
        // Creation establishes cleanup ownership even if the SDK's initial
        // async flush later rejects or the containing test reaches its deadline.
        registerStandardCleanupTarget(tree);
    });
    await flushHookEffects(options.flushOptions);

    return {
        tree,
        subscribe: notify => {
            listeners.add(notify);
            return () => { listeners.delete(notify); };
        },
        update: async (nextElement) => {
            await act(async () => {
                tree.update(renderElement(nextElement));
            });
            await flushHookEffects(options.flushOptions);
        },
        unmount: async () => {
            listeners.clear();
            unregisterStandardCleanupTarget(tree);
            await act(async () => {
                tree.unmount();
            });
        },
    };
}
