import { describe, expect, it } from 'vitest';

import {
    PluginUiCommonJsEvaluationError,
    evaluatePluginUiCommonJsBundle,
} from './commonJsEvaluator';

const identity = Object.freeze({
    pluginId: 'example.plugin',
    artifactId: 'example-surface',
    digest: 'sha256:example',
});

const encoder = new TextEncoder();

describe('evaluatePluginUiCommonJsBundle', () => {
    it('uses the production author-module map and refuses host-private presentation', () => {
        const read = evaluatePluginUiCommonJsBundle({
            bytes: encoder.encode('exports.read = () => Boolean(require("@happier-dev/plugin-ui") && require("@happier-dev/plugin-ui/components"));'),
            identity,
            requestedExport: 'read',
        });
        expect(read()).toBe(true);

        for (const specifier of [
            '@happier-dev/plugin-ui/presentation',
            '@happier-dev/plugin-ui/presentation/typeScale',
        ]) {
            expect(() => evaluatePluginUiCommonJsBundle({
                bytes: encoder.encode(`require(${JSON.stringify(specifier)}); exports.read = () => true;`),
                identity,
                requestedExport: 'read',
            })).toThrowError(expect.objectContaining({ code: 'unknown_host_module' }));
        }
    });

    it('supports both CommonJS export forms and validates the requested callable export', () => {
        const first = evaluatePluginUiCommonJsBundle({
            bytes: encoder.encode('module.exports = { renderSurface() { return "module"; } };'),
            identity,
            requestedExport: 'renderSurface',
            hostModules: Object.freeze({}),
        });
        const second = evaluatePluginUiCommonJsBundle({
            bytes: encoder.encode('exports.renderSurface = () => "exports";'),
            identity,
            requestedExport: 'renderSurface',
            hostModules: Object.freeze({}),
        });

        expect(first()).toBe('module');
        expect(second()).toBe('exports');
    });

    it('resolves exact host modules without prefix fallback', () => {
        const shared = Object.freeze({ value: 'shared' });
        const exported = evaluatePluginUiCommonJsBundle({
            bytes: encoder.encode('exports.read = () => require("host/exact").value;'),
            identity,
            requestedExport: 'read',
            hostModules: Object.freeze({ 'host/exact': shared }),
        });

        expect(exported()).toBe('shared');
        expect(() => evaluatePluginUiCommonJsBundle({
            bytes: encoder.encode('exports.read = () => require("host/exact/subpath"); exports.read();'),
            identity,
            requestedExport: 'read',
            hostModules: Object.freeze({ 'host/exact': shared }),
        })).toThrowError(expect.objectContaining({ code: 'unknown_host_module' }));
    });

    it('fatally rejects malformed UTF-8 before executing any prefix', () => {
        const touched = { value: false };
        expect(() => evaluatePluginUiCommonJsBundle({
            bytes: new Uint8Array([
                ...encoder.encode('require("touch").run();'),
                0xc3,
                0x28,
            ]),
            identity,
            requestedExport: 'renderSurface',
            hostModules: Object.freeze({ touch: { run: () => { touched.value = true; } } }),
        })).toThrowError(expect.objectContaining({ code: 'module_instantiation_failed' }));
        expect(touched.value).toBe(false);
    });

    it('reports a missing or non-callable requested export without caching namespace state', () => {
        for (const source of ['module.exports = {};', 'exports.renderSurface = 42;']) {
            expect(() => evaluatePluginUiCommonJsBundle({
                bytes: encoder.encode(source),
                identity,
                requestedExport: 'renderSurface',
                hostModules: Object.freeze({}),
            })).toThrowError(expect.objectContaining({ code: 'invalid_executable_export' }));
        }
    });

    it('isolates module and exports objects across concurrent evaluations', () => {
        const source = encoder.encode([
            'let count = 0;',
            'exports.increment = () => ++count;',
        ].join('\n'));
        const first = evaluatePluginUiCommonJsBundle({
            bytes: source,
            identity,
            requestedExport: 'increment',
            hostModules: Object.freeze({}),
        });
        const second = evaluatePluginUiCommonJsBundle({
            bytes: source,
            identity: { ...identity, artifactId: 'second' },
            requestedExport: 'increment',
            hostModules: Object.freeze({}),
        });

        expect(first()).toBe(1);
        expect(first()).toBe(2);
        expect(second()).toBe(1);
    });

    it('uses bounded diagnostics that never expose source or arbitrary thrown text', () => {
        try {
            evaluatePluginUiCommonJsBundle({
                bytes: encoder.encode('throw new Error("secret plugin payload");'),
                identity,
                requestedExport: 'renderSurface',
                hostModules: Object.freeze({}),
            });
            throw new Error('expected evaluator failure');
        } catch (error) {
            expect(error).toBeInstanceOf(PluginUiCommonJsEvaluationError);
            expect(String(error)).not.toContain('secret plugin payload');
        }
    });
});
