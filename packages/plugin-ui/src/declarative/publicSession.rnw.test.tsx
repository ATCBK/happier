import { act, createElement } from 'react';
import { describe, expect, it } from 'vitest';

import { buildPublicSessionDeclarativeView, mountPublicSessionDeclarative } from '../../../../apps/server/sources/app/api/routes/share/publicDeclarativeViewer.js';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginDeclarativeNodeV2Schema } from '@happier-dev/protocol/plugins/contributions/ui/v2';
import { publicSessionDeclarativeDocument as document } from './publicSession.fixture.testSupport.js';
import { buildArtifactHtmlDocumentV1 } from '@happier-dev/plugin-sdk/ui';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { externalTableVisual, externalHtmlVisual, externalHtmlBundle } from '../../fixtures/external-authoring/src/sessionVisuals.js';

describe('public Session portable declarative rendering', () => {
    it('admits and renders source-driven external author visuals through public bundle and Action contracts', () => {
        const schema = getActionSpec('session.board.item.upsert').inputSchema;
        expect(schema.safeParse(externalTableVisual).success).toBe(true);
        expect(schema.safeParse(externalHtmlVisual).success).toBe(true);
        const mounted = mountThroughReactNativeWeb(createElement('div', null,
            buildPublicSessionDeclarativeView(externalTableVisual.item.source.document, createSurfaceContext().theme)));
        try {
            expect(mounted.container.textContent).toContain('Copper');
            expect(mounted.container.textContent).toContain('0.000017');
            expect(mounted.container.querySelectorAll('button, [role="button"]')).toHaveLength(0);
        } finally { mounted.unmount(); }
        const html = buildArtifactHtmlDocumentV1(externalHtmlBundle);
        expect(html).toContain('External author visual');
        expect(html).toContain('Content-Security-Policy');
        expect(html).not.toContain('unsafe-eval');
    });
    it('renders Markdown, exact table values and state semantics through the portable owner', () => {
        const mounted = mountThroughReactNativeWeb(createElement('div', null,
            buildPublicSessionDeclarativeView(document, createSurfaceContext().theme)));
        try {
            expect(mounted.container.textContent).toContain('**Experiment result**');
            expect(mounted.container.textContent).toContain('Copper');
            expect(mounted.container.textContent).toContain('0.000017');
            expect(mounted.container.querySelector('[role="alert"]')?.textContent).toContain('Source unavailable');
            expect(mounted.container.querySelectorAll('button, [role="button"]')).toHaveLength(0);
        } finally { mounted.unmount(); }
    });

    it('rejects a private Resource source at Session admission and disposes a mounted public body', async () => {
        const privateResource = PluginDeclarativeNodeV2Schema.parse({
            kind: 'metric', label: 'Private spend', value: { path: ['cost'], type: 'number' },
            data: { kind: 'resource', resource: { pluginId: 'com.acme.private', localId: 'spend' },
                inputSchema: { type: 'object', properties: {}, additionalProperties: false },
                outputSchema: { type: 'object', properties: { cost: { type: 'number' } }, required: ['cost'], additionalProperties: false } },
        });
        expect(() => buildPublicSessionDeclarativeView({ version: 1, root: privateResource }, createSurfaceContext().theme)).toThrow();
        const root = globalThis.document.createElement('div');
        globalThis.document.body.append(root);
        let dispose: (() => void) | undefined;
        try {
            await act(async () => { dispose = mountPublicSessionDeclarative(root, document); });
            expect(root.textContent).toContain('Copper');
            act(() => dispose?.());
            dispose = undefined;
            expect(root.childElementCount).toBe(0);
        } finally { act(() => dispose?.()); root.remove(); }
    });
});
