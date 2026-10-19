import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { resolveBuiltInContributions } from './resolveBuiltInContributions';

const INSPECTOR_PLUGIN_ID = 'happier.inspector';

describe('bundled Inspector canonical UI graph', () => {
    it('carries the appPage description from the generated bundled manifest', () => {
        const page = resolveBuiltInContributions().uiViewsV2?.find(
            (entry) => entry.pluginId === INSPECTOR_PLUGIN_ID && entry.definition.container === 'appPage',
        );
        expect(page?.definition).toMatchObject({
            description: { key: 'plugins.inspector.description', fallback: 'Inspect installed plugins, diagnostics, and reload state.' },
        });
    });

    it('resolves manifest semantics and the generated physical graph without a handwritten UI map', () => {
        const contributions = resolveBuiltInContributions();
        const inspectorRenderer = contributions.uiRenderersV2?.find(
            (entry) => entry.pluginId === INSPECTOR_PLUGIN_ID,
        );
        const inspectorArtifacts = inspectorRenderer?.generatedUiArtifactsManifest?.entries ?? [];

        expect(contributions.settings?.filter((entry) => entry.pluginId === INSPECTOR_PLUGIN_ID)).toEqual([
            expect.objectContaining({
                definition: expect.objectContaining({
                    id: 'settings',
                    target: { kind: 'plugin' },
                    scope: 'daemon',
                }),
            }),
        ]);
        expect(contributions.uiViewsV2?.filter((entry) => entry.pluginId === INSPECTOR_PLUGIN_ID)).toEqual(expect.arrayContaining([
            expect.objectContaining({
                definition: expect.objectContaining({
                    id: 'inspector-app',
                    container: 'rightSidebarTab',
                    target: { kind: 'app' },
                    renderer: 'inspector-renderer',
                }),
            }),
        ]));
        expect(inspectorRenderer).toMatchObject({
            pluginId: INSPECTOR_PLUGIN_ID,
            definition: {
                id: 'inspector-renderer',
                kind: 'reactNative',
                artifact: 'inspector-app-native',
                requiredHostMethods: ['executeAction'],
            },
        });
        // The Inspector ships one bundle per translated locale, so this pins the
        // canonical `en` bundle rather than the locale count (same
        // `arrayContaining` shape the view assertion above uses).
        expect(contributions.uiTranslationsV2?.filter(
            (entry) => entry.pluginId === INSPECTOR_PLUGIN_ID,
        )).toEqual(expect.arrayContaining([
            expect.objectContaining({
                definition: expect.objectContaining({
                    locale: 'en',
                    messages: expect.objectContaining({
                        'plugins.inspector.title': 'Plugin Inspector',
                        'plugins.inspector.settings.showDiagnostics':
                            'Show diagnostics in Plugin Inspector',
                    }),
                }),
            }),
        ]));

        expect(inspectorArtifacts).toEqual([
          expect.objectContaining({
            artifactId: 'inspector-app-native',
            tier: 'reactNative',
            builtWith: expect.objectContaining({ bundler: 'esbuild' }),
            executable: { exports: ['renderSurface'] },
          }),
        ]);
        expect(inspectorArtifacts[0]).not.toHaveProperty('platform');
        expect(inspectorArtifacts[0]).not.toHaveProperty('repack');

        expect(contributions).not.toHaveProperty('uiTranslations');

        const resolverSource = readFileSync(
            new URL('./resolveBuiltInContributions.ts', import.meta.url),
            'utf8',
        );
        expect(resolverSource).not.toMatch(/firstPartyUiContributions|FIRST_PARTY_(?:UI|SURFACE|REACT_NATIVE)/u);
    });
});
