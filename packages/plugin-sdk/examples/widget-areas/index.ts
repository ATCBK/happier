import { watch } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { definePlugin } from '@happier-dev/plugin-sdk';
import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import type { PluginResourceContextV1 } from '@happier-dev/plugin-sdk/resources';
import { PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1 } from '@happier-dev/plugin-sdk/ui/build';
import type { PluginUiHostApi, PluginUiWidgetAreaOperationV1 } from '@happier-dev/plugin-sdk/ui';
import { definePluginDeclarativeDocumentV1, PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1 } from '@happier-dev/plugin-sdk/ui';
import { inspectedItemSchema, sampleCardSchema } from './entityContract.js';

const countKindSchema = { type: 'string', enum: ['files', 'folders'] } satisfies PluginJsonSchema;
const countKindOptions = [{ value: 'files', label: 'Files' }, { value: 'folders', label: 'Folders' }];
const directoryInputSchema = {
    type: 'object', additionalProperties: false, required: ['directory', 'filter'],
    properties: { directory: { type: 'string', minLength: 1 }, filter: countKindSchema },
} satisfies PluginJsonSchema;

function readDirectoryInputs(context: PluginResourceContextV1) {
    const input = context.kind === 'surface' ? context.launchInput : null;
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || !('directory' in input) || !('filter' in input)
        || typeof input.directory !== 'string' || input.directory.length === 0
        || (input.filter !== 'files' && input.filter !== 'folders')) {
        throw new Error('Directory count needs a directory and a Files or Folders filter from its mounted surface.');
    }
    return { directory: input.directory, filter: input.filter };
}

async function countDirectory(context: PluginResourceContextV1) {
    const { directory, filter } = readDirectoryInputs(context);
    const entries = await readdir(directory, { withFileTypes: true });
    return { directory, filter,
        count: entries.filter(entry => filter === 'files' ? entry.isFile() : entry.isDirectory()).length };
}

const observeDirectory = (invalidate: () => void, { context }: { context: PluginResourceContextV1 }) => {
    const { directory } = readDirectoryInputs(context);
    const watcher = watch(directory, invalidate);
    watcher.on('error', invalidate);
    return { dispose: () => watcher.close() };
};
const entityClient = { artifactId: 'entity-drag-drop', exportName: 'activate' };

export const widgetAreasPlugin = definePlugin({
    id: 'examples.widget-areas', version: '1.0.0', displayName: 'Widget areas',
    runtime: { apiVersion: Number(PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.toolchain.runtime) as 1 },
    entrypoints: { daemon: './dist/index.js' },
    dragSources: { 'sample-card': { title: 'Sample card', referenceSchema: sampleCardSchema.jsonSchema,
        client: entityClient, platforms: ['web', 'ios', 'android'] } },
    dropTargets: { 'inspect-item': { title: 'Inspect item',
        acceptedKinds: ['session', 'plugin:examples.widget-areas/sample-card'],
        actions: [{ kind: 'plugin', action: 'inspect-drop' }], client: entityClient, platforms: ['web', 'ios', 'android'] } },
    actions: { 'inspect-drop': { title: 'Inspect dropped item',
        description: 'Open a carried Session or sample reference on this client without modifying it.',
        surfaces: ['ui', 'agent', 'mcp', 'cli'], placementBindings: [], dangerLevel: 'safe',
        execution: { target: 'client', client: entityClient, platforms: ['web', 'ios', 'android'] },
        inputSchema: inspectedItemSchema } },
    inputTypes: { 'count-kind': { title: 'Count kind', semantic: 'directory-count-kind',
        valueSchema: countKindSchema, options: { resource: 'count-kinds' } } },
    resources: {
        'count-kinds': { source: 'dynamic', kind: 'config', scope: 'global', contentType: 'application/json',
            runtime: { read: () => JSON.stringify(countKindOptions), observe: () => ({ dispose() {} }) } },
        count: { source: 'dynamic', kind: 'config', scope: 'surface', contentType: 'application/json',
        runtime: {
            read: async ({ context }) => JSON.stringify(await countDirectory(context)),
            observe: observeDirectory,
        } },
        'count-document': { source: 'dynamic', kind: 'config', scope: 'surface',
            // The host declarative-document Resource contract admits at most 512 KiB.
            maxBytes: 512 * 1024,
            contentType: PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1, runtime: {
                read: async ({ context }) => {
                    const { count, filter } = await countDirectory(context);
                    return JSON.stringify(definePluginDeclarativeDocumentV1({ version: 1, root: { kind: 'metric', label: filter === 'files' ? 'Files' : 'Folders',
                        data: { kind: 'value', value: count }, value: { path: [], type: 'number' } } }));
                },
                observe: observeDirectory,
            } },
    },
    ui: {
        views: [
            { id: 'overview', title: 'Widget areas', container: 'appPage', target: { kind: 'app' }, renderer: 'overview-native',
                widgetAreas: [{ name: 'pinned', contextSchema: directoryInputSchema }] },
            { id: 'counter', title: 'Directory count', container: 'widget', target: { kind: 'app' }, renderer: 'counter-native',
                sizeDeclaration: { sizes: ['small', 'medium', 'wide', 'full'], defaultSize: 'medium' },
                resources: [{ pluginId: 'examples.widget-areas', localId: 'count' }],
                inputs: { fields: [
                    { path: 'directory', title: 'Directory on the serving machine', widget: 'text', required: true },
                    { path: 'filter', title: 'Count', widget: 'select', required: true,
                        inputType: { pluginId: 'examples.widget-areas', localId: 'count-kind' } },
                ] },
                inputSchema: directoryInputSchema },
            { id: 'snapshot-counter', title: 'Directory count for snapshots', container: 'widget', target: { kind: 'app' }, renderer: 'counter-declarative',
                sizeDeclaration: { sizes: ['small', 'medium', 'wide', 'full'], defaultSize: 'medium' },
                resources: [{ pluginId: 'examples.widget-areas', localId: 'count-document' }],
                inputs: { fields: [
                    { path: 'directory', title: 'Directory on the serving machine', widget: 'text', required: true },
                    { path: 'filter', title: 'Count', widget: 'select', required: true,
                        inputType: { pluginId: 'examples.widget-areas', localId: 'count-kind' } },
                ] }, inputSchema: directoryInputSchema },
        ],
        renderers: [
            { id: 'overview-native', kind: 'reactNative', artifact: 'overview-native', requiredHostMethods: ['widgetArea'] },
            { id: 'counter-native', kind: 'reactNative', artifact: 'counter-native', requiredHostMethods: ['readResource', 'watchResource'] },
            { id: 'counter-declarative', kind: 'declarative', root: { kind: 'text', text: 'Choose a directory to count.' },
                documentSource: { kind: 'resource', resourceId: 'count-document' } },
        ],
    },
});

export const { manifest, activate } = widgetAreasPlugin;

/** Native and declarative pages use the shared area port; hosted HTML uses ordinary widget Actions. */
export function runWidgetAreaExample(host: Pick<PluginUiHostApi, 'widgetArea'>, operation: PluginUiWidgetAreaOperationV1, filter = 'files', directory = '.') {
    return host.widgetArea({ area: 'pinned', context: { directory, filter }, operation });
}
