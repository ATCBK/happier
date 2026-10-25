import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('vitest config aliases', () => {
    it('replaces the whole nested SVG native module path while keeping its XML parser real', async () => {
        const { default: config } = await import('../../vitest.config');
        const aliases = Array.isArray(config.resolve?.alias) ? config.resolve.alias : [];
        const nativeModule = resolve(__dirname, '../../node_modules/react-native-svg/lib/module/xmlTags.js');
        for (const path of [nativeModule, `/@fs${nativeModule}`, 'C:\\workspace\\apps\\ui\\node_modules\\react-native-svg\\lib\\module\\xmlTags.js']) {
            const alias = aliases.find(entry => entry.find instanceof RegExp && entry.find.test(path));
            if (!alias || !(alias.find instanceof RegExp)) throw new Error('Missing native SVG boundary');
            expect(path.replace(alias.find, alias.replacement)).toBe(resolve(__dirname, 'testkit/mocks/reactNativeSvg.ts'));
        }
        const parser = resolve(__dirname, '../../node_modules/react-native-svg/lib/module/xml.js');
        expect(aliases.some(entry => entry.find instanceof RegExp && entry.find.test(parser))).toBe(false);
    });

    it('stubs expo-modules-core subpaths to avoid loading Expo TS sources in node tests', async () => {
        const module = await import('../../vitest.config');
        const config = module.default as {
            resolve?: { alias?: Array<{ find: unknown; replacement: string }> };
            plugins?: Array<{ name?: string }>;
        };
        const aliasEntries = Array.isArray(config.resolve?.alias)
            ? config.resolve.alias
            : [];

        const expoModulesCoreAlias = aliasEntries.find((entry) => {
            if (!(entry.find instanceof RegExp)) return false;
            return entry.find.test('expo-modules-core/src/index.ts');
        });

        expect(expoModulesCoreAlias, 'expected expo-modules-core alias to match subpaths').toBeTruthy();
        expect(expoModulesCoreAlias?.replacement).toContain('expoModulesCoreStub.ts');

        const plugins = Array.isArray(config.plugins)
            ? config.plugins
            : [];
        expect(plugins.some((plugin) => plugin.name === 'happier-vitest-expo-node-module-stubs')).toBe(true);
    });

    it('resolves workspace agent imports to source files so vitest does not load stale dist exports', async () => {
        const module = await import('../../vitest.config');
        const config = module.default as {
            plugins?: Array<{
                name?: string;
                resolveId?: (id: string, importer?: string) => string | null | undefined;
            }>;
        };
        const plugins = Array.isArray(config.plugins)
            ? config.plugins
            : [];
        const resolver = plugins.find((plugin) => plugin.name === 'happier-vitest-expo-node-module-stubs');

        expect(resolver?.resolveId?.('@happier-dev/agents')).toContain('/packages/agents/src/index.ts');
        expect(resolver?.resolveId?.('@happier-dev/agents/permissions')).toContain(
            '/packages/agents/src/permissions/index.ts',
        );
        expect(resolver?.resolveId?.('@happier-dev/protocol/installablesPolicy')).toContain(
            '/packages/protocol/src/installables/policy.ts',
        );
        expect(
            resolver?.resolveId?.(
                './cli/runtime.js',
                resolve(__dirname, '../../../../packages/agents/src/index.ts'),
            ),
        ).toContain('/packages/agents/src/cli/runtime.ts');
        expect(
            resolver?.resolveId?.(
                './localControl',
                resolve(__dirname, '../../../../packages/agents/src/localControl.test.ts'),
            ),
        ).toContain('/packages/agents/src/localControl.ts');
    });

    it('stubs react-native-enriched-markdown so MarkdownView tests do not load native modules', async () => {
        const module = await import('../../vitest.config');
        const config = module.default as {
            resolve?: { alias?: Array<{ find: unknown; replacement: string }> };
        };
        const aliasEntries = Array.isArray(config.resolve?.alias)
            ? config.resolve.alias
            : [];

        const matches = (find: unknown, id: string) => find instanceof RegExp ? find.test(id) : find === id;
        const enrichedMarkdownAlias = aliasEntries.find((entry) => matches(entry.find, 'react-native-enriched-markdown'));

        expect(enrichedMarkdownAlias, 'expected enriched markdown to use a node-safe test stub').toBeTruthy();
        expect(enrichedMarkdownAlias?.replacement).toContain('reactNativeEnrichedMarkdownStub.tsx');
        // Only the public native view is stubbed; package subpaths keep the real patched logic.
        expect(matches(enrichedMarkdownAlias?.find, 'react-native-enriched-markdown/lib/module/web/streamingReveal.js')).toBe(false);
    });

    it('stubs posthog-react-native so tracking imports do not load optional Expo native packages', async () => {
        const module = await import('../../vitest.config');
        const config = module.default as {
            resolve?: { alias?: Array<{ find: unknown; replacement: string }> };
        };
        const aliasEntries = Array.isArray(config.resolve?.alias)
            ? config.resolve.alias
            : [];

        const posthogAlias = aliasEntries.find((entry) => entry.find === 'posthog-react-native');

        expect(posthogAlias, 'expected PostHog to use a node-safe test stub').toBeTruthy();
        expect(posthogAlias?.replacement).toContain('posthogReactNativeStub.tsx');
    });
});
