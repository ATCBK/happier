import { definePlugin, PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import { defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import { PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1 } from '@happier-dev/plugin-sdk/ui/build';
import { initialRows } from './rows.js';

/** QA-only, occurrence-local fixture data; no Account database or catalog registration. */
export function createCollectionDetailPlugin() {
    let rows = [...initialRows];
    let disposed = false;
    const observers = new Map<() => void, () => void>();
    const invalidate = () => { for (const observer of observers.values()) observer(); };
    return definePlugin({
        id: 'qa.collection-detail', version: '0.1.0', displayName: 'QA · Review collection',
        runtime: { apiVersion: Number(PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.toolchain.runtime) as 1 },
        entrypoints: { daemon: './dist/index.js', development: './src/index.ts' },
        setup: () => {
            disposed = false;
            rows = [...initialRows];
            return () => { disposed = true; for (const dispose of observers.keys()) dispose(); };
        },
        resources: { rows: { source: 'dynamic', kind: 'config', scope: 'global', contentType: 'application/json', runtime: {
            read: ({ signal }) => {
                signal.throwIfAborted();
                if (disposed) throw new PluginError({ code: 'qa_occurrence_disposed' });
                return JSON.stringify({ rows });
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
            'set-complete': {
                title: 'Set review completion', execution: { target: 'daemon' }, surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
                dangerLevel: 'writesLocal', placementBindings: ['rowAction'],
                confirmationWhen: { presentUserUi: false },
                confirmation: { title: 'Change QA review completion', body: 'Updates only this plugin’s transient sample reviews.', confirmLabel: 'Update review' },
                inputSchema: defineProtocolObject({
                    rowId: defineProtocolString({ minLength: 1 }),
                    completed: defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]),
                }, { policy: 'closed' }),
                run: (input): JsonValue => {
                    const row = rows.find(row => row.id === input.rowId);
                    if (!row) return { ok: false, code: 'row_not_found' };
                    if (row.completed !== input.completed) {
                        rows = rows.map(current => current.id === row.id ? { ...current, completed: input.completed } : current);
                        invalidate();
                    }
                    return { ok: true, row: { ...row, completed: input.completed } };
                },
            },
            clear: { title: 'Clear QA rows', execution: { target: 'daemon' }, dangerLevel: 'writesLocal',
                confirmation: { title: 'Clear sample reviews', body: 'Removes the transient sample rows; Restore reviews brings them back.', confirmLabel: 'Clear reviews' },
                surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'], inputSchema: defineProtocolObject({}, { policy: 'closed' }),
                run: () => { if (rows.length) { rows = []; invalidate(); } return { rows }; } },
            restore: { title: 'Restore QA rows', execution: { target: 'daemon' }, dangerLevel: 'writesLocal',
                confirmation: { title: 'Restore sample reviews', body: 'Replaces the transient reviews with their starting values.', confirmLabel: 'Restore reviews' },
                surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'], inputSchema: defineProtocolObject({}, { policy: 'closed' }),
                run: () => { rows = [...initialRows]; invalidate(); return { rows }; } },
        },
        ui: {
            views: [{ id: 'reviews', title: 'QA · Review collection', container: 'appPage', target: { kind: 'app' }, renderer: 'collection-native',
                description: { key: 'reviews.purpose', fallback: 'Review sample work and mark it complete. Changes last until this QA plugin reloads.' } }],
            renderers: [{ id: 'collection-native', kind: 'reactNative', artifact: 'collection-native',
                requiredHostMethods: ['readResource', 'watchResource', 'executeAction'] }],
        },
    });
}

export const { manifest, activate } = createCollectionDetailPlugin();
