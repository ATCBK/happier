import { describe, expect, it } from 'vitest';
import { SessionSurfaceItemV1Schema, type SessionSurfaceItemV1 } from '@happier-dev/protocol/sessions/board';
import { WidgetDefinitionV1Schema } from '@happier-dev/protocol/widgets';
import { createSessionBoardSourceAvailabilityResolver, resolveSessionBoardItemPresentation } from './sessionBoardItemPresentation';

const source: SessionSurfaceItemV1['source'] = {
    kind: 'widget',
    instance: { v: 1, id: 'widget-b', definition: { kind: 'installed', surface: { pluginId: 'acme.review', localId: 'review-status-widget' } },
        bindings: { session: { kind: 'value', value: { serverId: 'home-a', sessionId: 'session-b' } } } },
};

describe('configured Session widget presentation', () => {
    it.each(['declarative', 'html', 'installed'] as const)('admits an inline %s copy at renderer presence without borrowing plugin authority', kind => {
        const definition = WidgetDefinitionV1Schema.parse({ v: 1, id: 'saved', name: 'Saved copy',
            sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' }, inputs: { fields: [] },
            inputSchema: { type: 'object', additionalProperties: false }, provenance: { source: { kind: 'authored' } },
            body: kind === 'declarative' ? { kind, document: { version: 1, root: { kind: 'text', text: 'Copied result' } } }
                : kind === 'html' ? { kind, source: { v: 1, entrypoint: 'index.html', files: {
                    'index.html': { mime: 'text/html', contentBase64: 'PGI+aGk8L2I+' },
                } } } : { kind, surface: { pluginId: 'acme.missing', localId: 'widget' } } });
        const item = SessionSurfaceItemV1Schema.parse({ v: 1, title: 'Copy', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
            source: { kind: 'widget', instance: { v: 1, id: 'copy', definition: { kind: 'inline', definition }, bindings: {} } } });
        const resolver = createSessionBoardSourceAvailabilityResolver({ hostedHtmlRendererAvailable: true });
        expect(resolveSessionBoardItemPresentation({ state: { kind: 'ready', item }, mountMode: 'executable', canEdit: true,
            canOpenElsewhere: false, resolveSourceAvailability: resolver })).toEqual({ kind: 'content' });
        if (kind === 'html') expect(createSessionBoardSourceAvailabilityResolver()(item.source))
            .toEqual({ kind: 'unavailable', reason: 'hosted_html_renderer_unavailable' });
        expect(SessionSurfaceItemV1Schema.safeParse({ ...item, source: { kind: 'widget', instance: {
            v: 1, id: 'copy', definition: { kind: 'artifact', artifactId: 'private' }, bindings: {},
        } } }).success).toBe(false);
    });
    it('does not exclude pinned B because physical A has no plugin projection', () => {
        const resolveSourceAvailability = createSessionBoardSourceAvailabilityResolver();
        expect(resolveSourceAvailability(source)).toEqual({ kind: 'available' });
        const item: SessionSurfaceItemV1 = { v: 1, title: 'Review status', frame: 'card', height: { mode: 'auto', fallback: 'regular' }, source };
        expect(resolveSessionBoardItemPresentation({
            state: { kind: 'ready', item }, mountMode: 'preview', canEdit: true,
            canOpenElsewhere: true, resolveSourceAvailability,
        }).kind).toBe('preview');
    });
});
