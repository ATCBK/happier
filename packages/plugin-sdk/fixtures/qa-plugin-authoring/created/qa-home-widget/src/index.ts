import { definePlugin, PluginError } from '@happier-dev/plugin-sdk';
import { defineProtocolNumber, defineProtocolObject } from '@happier-dev/plugin-sdk/protocol';
import { PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1 } from '@happier-dev/plugin-sdk/ui/build';

/** QA-only transient data shared by this occurrence's widget and companion page. */
export function createHomeWidgetPlugin() {
    let completed = 0;
    let disposed = false;
    const observers = new Map<() => void, () => void>();
    return definePlugin({
        id: 'qa.home-widget', version: '0.1.0', displayName: 'QA · Review progress',
        runtime: { apiVersion: Number(PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.toolchain.runtime) as 1 },
        entrypoints: { daemon: './dist/index.js', development: './src/index.ts' },
        setup: () => {
            completed = 0;
            disposed = false;
            return () => { disposed = true; for (const dispose of observers.keys()) dispose(); };
        },
        resources: { summary: { source: 'dynamic', kind: 'config', scope: 'global', contentType: 'application/json', runtime: {
            read: ({ signal }) => {
                signal.throwIfAborted();
                if (disposed) throw new PluginError({ code: 'qa_occurrence_disposed' });
                return JSON.stringify({ completed, goal: 3 });
            },
            observe: (invalidate, { signal }) => {
                signal.throwIfAborted();
                if (disposed) throw new PluginError({ code: 'qa_occurrence_disposed' });
                const dispose = () => { observers.delete(dispose); signal.removeEventListener('abort', dispose); };
                observers.set(dispose, invalidate);
                signal.addEventListener('abort', dispose, { once: true });
                return { dispose };
            },
        } } },
        actions: {
            'set-completed': { title: 'Set completed reviews', execution: { target: 'daemon' }, dangerLevel: 'writesLocal',
                confirmation: { title: 'Update QA review progress', body: 'Changes only this plugin’s transient review count.', confirmLabel: 'Update progress' },
                surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
                inputSchema: defineProtocolObject({
                    completed: defineProtocolNumber({ integer: true, minimum: 0 }),
                }, { policy: 'closed' }),
                run: input => {
                    if (completed !== input.completed) {
                        completed = input.completed;
                        for (const invalidate of observers.values()) invalidate();
                    }
                    return { completed, goal: 3 };
                },
            },
        },
        ui: {
            views: [
                { id: 'progress', title: 'QA · Review progress', container: 'widget', target: { kind: 'app' }, renderer: 'summary-native',
                    home: { default: 'available' },
                    sizeDeclaration: { sizes: ['small', 'medium', 'wide', 'full'], defaultSize: 'medium' },
                    resources: [{ pluginId: 'qa.home-widget', localId: 'summary' }] },
                { id: 'overview', title: 'QA · Review progress', container: 'appPage', target: { kind: 'app' }, renderer: 'overview-native',
                    widgetAreas: [{ name: 'pinned', contextSchema: { type: 'object', additionalProperties: false, properties: {} } }] },
            ],
            renderers: [
                { id: 'summary-native', kind: 'reactNative', artifact: 'summary-native', requiredHostMethods: ['readResource', 'watchResource', 'executeAction', 'openSurface'] },
                { id: 'overview-native', kind: 'reactNative', artifact: 'overview-native', requiredHostMethods: ['readResource', 'watchResource', 'executeAction', 'widgetArea'] },
            ],
        },
    });
}

export const { manifest, activate } = createHomeWidgetPlugin();
