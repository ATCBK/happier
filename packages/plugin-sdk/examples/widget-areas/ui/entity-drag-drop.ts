/** Portable client activation; no renderer or platform-specific module is required. */
import type { PluginClientApi, PluginDragSourceRuntime, PluginDropTargetRuntime } from '@happier-dev/plugin-sdk';
import type { PluginClientActionHandler } from '@happier-dev/plugin-sdk/actions';
import { inspectedItemSchema, sampleCardSchema } from '../entityContract.js';

export const sampleCardSource: PluginDragSourceRuntime = {
    describe(reference) {
        const parsed = sampleCardSchema.safeParse(reference);
        return parsed.success ? { title: parsed.data.title, subtitle: 'Widget areas sample' } : null;
    },
};

export const inspectItemTarget: PluginDropTargetRuntime = {
    resolve({ item }) {
        const input = item.kind === 'session' ? { kind: 'session', address: item.address }
            : item.kind === 'plugin' && item.contribution.pluginId === 'examples.widget-areas'
                && item.contribution.localId === 'sample-card' ? { kind: 'sample', reference: item.reference } : null;
        const parsed = inspectedItemSchema.safeParse(input);
        if (!parsed.success) return { status: 'refused', reason: {
            code: 'widget_areas_item_invalid', message: 'Choose a Session or a Widget areas sample card.',
        } };
        return { status: 'allowed', effect: {
            actionId: 'plugin:examples.widget-areas/inspect-drop', input: parsed.data,
            preview: { verb: 'Inspect', target: 'Widget areas', consequence: 'Opens the reference without changing it', glyph: 'open' },
        } };
    },
};

/** Opening an inspection uses the host Action/navigation owner; hover never changes the page. */
export const inspectDrop: PluginClientActionHandler = async (input, context) => {
    const inspected = inspectedItemSchema.parse(input);
    await context.ui.openSurface('overview', inspected, { signal: context.signal });
};

export function activate(api: PluginClientApi): void {
    api.dragSources.register('sample-card', sampleCardSource);
    api.dropTargets.register('inspect-item', inspectItemTarget);
    api.actions.register('inspect-drop', inspectDrop);
}
