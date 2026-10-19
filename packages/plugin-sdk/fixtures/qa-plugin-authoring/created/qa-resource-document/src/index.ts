import { definePlugin, defineUiSurfaceDefinition } from '@happier-dev/plugin-sdk';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import type { PluginDynamicResourceRuntime } from '@happier-dev/plugin-sdk/resources';

const documentInput = defineProtocolObject({ text: defineProtocolString() }, { policy: 'closed' });
let document = '';
const observers = new Set<() => void>();

const documentResource: PluginDynamicResourceRuntime = {
    read({ signal }) {
        signal.throwIfAborted();
        return document;
    },
    observe(invalidate, { signal }) {
        signal.throwIfAborted();
        const listener = () => { if (!signal.aborted) invalidate(); };
        observers.add(listener);
        const dispose = () => {
            observers.delete(listener);
            signal.removeEventListener('abort', dispose);
        };
        signal.addEventListener('abort', dispose, { once: true });
        if (signal.aborted) dispose();
        return { dispose };
    },
};

export const { manifest, activate } = definePlugin({
    id: 'qa.resource-document', version: '0.1.0', displayName: 'QA resource document',
    description: 'QA-only live document fixture. Its demonstration state lasts for this loaded module.',
    entrypoints: { daemon: './dist/index.js', development: './src/index.ts' },
    actions: {
        'document-write': {
            title: 'Write document', description: 'Replace the demonstration document.',
            execution: { target: 'daemon' }, scopes: ['global'],
            surfaces: ['agent', 'cli', 'mcp', 'ui'], dangerLevel: 'safe',
            inputSchema: documentInput, resultSchema: documentInput,
            run(input, context) {
                context.signal?.throwIfAborted();
                if (document !== input.text) {
                    document = input.text;
                    for (const invalidate of observers) invalidate();
                }
                return { text: input.text };
            },
        },
    },
    resources: {
        document: { source: 'dynamic', kind: 'config', scope: 'global', contentType: 'text/markdown', runtime: documentResource },
    },
    ui: { surfaces: [defineUiSurfaceDefinition({
        id: 'document-page', placement: 'appPage', title: 'QA resource document',
        renderer: { kind: 'reactNative', requiredHostMethods: ['context', 'executeAction', 'readResource', 'watchResource'] },
    })] },
});
