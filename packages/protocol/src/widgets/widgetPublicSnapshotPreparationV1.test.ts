import { describe, expect, it } from 'vitest';
import { createWorkBoardArtifactBoundary } from '../boards/workBoardArtifactV1.testkit.js';
import { createWidgetDefinitionArtifactPortV1, type WidgetDefinitionArtifactTransportV1 } from './widgetDefinitionArtifactV1.js';
import { WidgetDefinitionV1Schema, type WidgetDefinitionV1 } from './widgetDefinitionV1.js';
import { compileWidgetAreaPublicProfileLayoutV1 } from './widgetPublicSnapshotPreparationV1.js';
import { WidgetPublicSnapshotPresentationV1Schema } from './widgetPublicSnapshotV1.js';
import { WidgetAreaLayoutV1Schema, type WidgetAreaLayoutV1 } from './widgetSurfaceArtifactV1.js';

const presentation = WidgetPublicSnapshotPresentationV1Schema.parse({ kind: 'declarative', document: { version: 1,
    root: { kind: 'metric', label: 'Active days', data: { kind: 'value', value: { kind: 'public_profile' } },
        value: { path: ['snapshot', 'facts', 'activeDays'], type: 'number' } } } });
const definition = (): WidgetDefinitionV1 => WidgetDefinitionV1Schema.parse({ v: 1, id: 'shared-days', name: 'Days',
    sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' }, inputs: { fields: [] },
    inputSchema: { type: 'object', additionalProperties: false }, publicPresentation: presentation,
    body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Private live body' } } },
    provenance: { source: { kind: 'authored' } } });
const area = (): WidgetAreaLayoutV1 => WidgetAreaLayoutV1Schema.parse({ v: 1,
    surface: { serverId: 'home', accountId: 'owner', owner: { kind: 'corePage', pageId: 'public-profile', area: 'main' } },
    items: [{ kind: 'group', id: 'group', title: 'Shared facts', width: 'full', frameStyle: 'plain', dividers: 'none',
        children: [{ kind: 'widget', instance: { v: 1, id: 'days', definition: { kind: 'artifact', artifactId: 'shared-days' }, bindings: {} } }] }] });

describe('public widget snapshot preparation', () => {
    it('copies an authored Artifact declaration and leaves the reviewed edition independent of later edits and deletion', async () => {
        const boundary = createWorkBoardArtifactBoundary();
        const transport: WidgetDefinitionArtifactTransportV1 = { ...boundary.transport,
            read: async (id, options) => { const row = await boundary.transport.read(id, options); return row ? { ...row, ownerAccountId: 'owner' } : null; },
            list: async options => { const page = await boundary.transport.list(options); return { ...page,
                items: page.items.map(row => ({ ...row, ownerAccountId: 'owner' })) }; },
        };
        const port = createWidgetDefinitionArtifactPortV1(transport, { accountId: 'owner' });
        await port.create(definition());
        expect(await port.list()).toMatchObject([{ publicPresentation: presentation }]);
        const sources = { resolveDefinition: (ref: { artifactId: string }) => port.get(ref.artifactId), resolveInstalledView: () => null };
        const copied = await compileWidgetAreaPublicProfileLayoutV1(area(), sources);
        expect(copied).toEqual({ v: 1, items: [{ kind: 'group', id: 'group', title: 'Shared facts', width: 'full',
            frameStyle: 'plain', dividers: 'none', children: [{ kind: 'widget', id: 'days', title: 'Days', size: 'medium',
                frameStyle: 'card', presentation }] }] });
        expect(JSON.stringify(copied)).not.toContain('Private live body');
        await port.update('shared-days', { publicPresentation: null });
        expect(await port.get('shared-days')).not.toHaveProperty('publicPresentation');
        await expect(compileWidgetAreaPublicProfileLayoutV1(area(), sources)).rejects.toMatchObject({
            code: 'widget_public_presentation_unavailable', instanceId: 'days' });
        await port.delete('shared-days');
        expect(copied.items[0]).toMatchObject({ children: [{ presentation }] });
    });

    it('copies builtin presentation choices and refuses private pins, group contexts and unsupported bodies', async () => {
        const layout = area();
        const group = layout.items[0];
        if (group.kind !== 'group') throw new Error('Expected group');
        const child = group.children[0];
        child.instance.definition = { kind: 'builtin', id: 'usage_rhythm' };
        child.instance.bindings = { style: { kind: 'value', value: 'sky' }, colourBy: { kind: 'value', value: 'intensity' } };
        const sources = { resolveDefinition: () => null, resolveInstalledView: () => null };
        expect(await compileWidgetAreaPublicProfileLayoutV1(layout, sources)).toMatchObject({ items: [{ children: [{
            presentation: { kind: 'usage', widgetId: 'usage_rhythm', inputs: { style: 'sky', colourBy: 'intensity' } } }] }] });
        for (const invalid of ['privateBinding', 'groupContext', 'unsupported'] as const) {
            const current = WidgetAreaLayoutV1Schema.parse(layout);
            const item = current.items[0];
            if (item.kind !== 'group') throw new Error('Expected group');
            if (invalid === 'privateBinding') item.children[0].instance.bindings.query = { kind: 'context', slot: 'query' };
            if (invalid === 'groupContext') item.context = { style: { kind: 'value', value: 'sky' } };
            if (invalid === 'unsupported') item.children[0].instance.definition = { kind: 'builtin', id: 'usage_score' };
            await expect(compileWidgetAreaPublicProfileLayoutV1(current, sources)).rejects.toMatchObject({
                code: 'widget_public_presentation_unavailable', instanceId: 'days' });
        }
    });

    it('keeps the public declaration closed and rejects executable and precomputed private data', () => {
        const original = definition();
        for (const invalid of [{ ...presentation, renderer: 'live' },
            { kind: 'declarative', document: { version: 1, root: { kind: 'metric', label: 'Private field',
                data: { kind: 'value', value: { kind: 'public_profile' } }, value: { path: ['snapshot', 'facts', 'privateTotal'], type: 'number' } } } },
            { kind: 'declarative', document: { version: 1, root: { kind: 'action', title: 'Run', actionId: 'usage.query' } } },
            { kind: 'declarative', document: { version: 1, root: { kind: 'metric', label: 'Private amount',
                data: { kind: 'value', value: { amount: 123456789 } }, value: { path: ['amount'], type: 'number' } } } }]) {
            expect(WidgetDefinitionV1Schema.safeParse({ ...original, publicPresentation: invalid }).success).toBe(false);
        }
    });
});
