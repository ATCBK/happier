import { PluginUiHostApiSurfaceContextV1Schema, type PluginUiTargetedContributionsV1 } from '@happier-dev/protocol/plugins/ui';
import { act } from 'react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { createPluginSurfaceContextFixture } from '@/dev/testkit/fixtures/pluginSurfaceContextFixture';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { storage } from '@/sync/domains/state/storage';

import { createPluginSurfaceContext, preparePluginSurfaceContext, usePluginSurfaceEnvironment } from './pluginSurfaceContext';
import * as stableJson from '@/utils/json/stableJsonStringify';

const targetedContributions: PluginUiTargetedContributionsV1 = {
    target: {
        pluginId: 'acme.preview',
        occurrenceId: 'target-generation-a',
        sourceCustody: { kind: 'development', registeredRootId: 'preview-root' },
    },
    points: [],
};

describe('createPluginSurfaceContext', () => {
    it('admits host publications once and does no parsing, walking or stringify on unchanged reads', () => {
        const fixture = createPluginSurfaceContextFixture();
        const translations = { title: 'Original' };
        const input = {
            mount: fixture.mount,
            target: fixture.target,
            accountEncryptionMode: fixture.accountEncryptionMode,
            environment: { ...fixture, columnVisible: false },
            translations,
            targetedContributions: fixture.targetedContributions,
        };
        const prepared = preparePluginSurfaceContext(createPluginSurfaceContext(input));
        const published = prepared.surface;
        // Instrument the real owners; none of their implementations is replaced.
        const parse = vi.spyOn(PluginUiHostApiSurfaceContextV1Schema, 'parse');
        const stringify = vi.spyOn(stableJson, 'stableJsonStringify');
        const descriptors = vi.spyOn(Object, 'getOwnPropertyDescriptors');
        onTestFinished(() => { parse.mockRestore(); stringify.mockRestore(); descriptors.mockRestore(); });
        const reads = Array.from({ length: 100 }, () => preparePluginSurfaceContext(published, prepared));
        const counts = { parses: parse.mock.calls.length, stringify: stringify.mock.calls.length, walks: descriptors.mock.calls.length };
        expect(counts).toEqual({ parses: 0, stringify: 0, walks: 0 });
        expect(reads.every(value => value === prepared)).toBe(true);
        expect(prepared.surface).toBe(published);
        expect(Object.isFrozen(published.translations)).toBe(true);
        expect(Object.isFrozen(translations)).toBe(false);
        translations.title = 'Changed';
        expect(published.translations.title).toBe('Original');
        const next = preparePluginSurfaceContext(createPluginSurfaceContext(input), prepared);
        expect(next.surface.translations.title).toBe('Changed');
        expect(next.semanticKey).not.toBe(prepared.semanticKey);
        expect(next.surface.target).toBe(prepared.surface.target);
        expect(next.surface.theme).toBe(prepared.surface.theme);

        // Copying/freezing a wrapper never admits mutable children or invalid input.
        const raw = Object.freeze({ ...published, translations });
        parse.mockClear();
        expect(preparePluginSurfaceContext(raw).surface.translations.title).toBe('Changed');
        translations.title = 'Changed again';
        expect(preparePluginSurfaceContext(raw).surface.translations.title).toBe('Changed again');
        expect(parse).toHaveBeenCalledTimes(2);
        expect(() => preparePluginSurfaceContext(Object.freeze({ ...published, textScale: -1 }))).toThrow();
    });
    it('validates fresh input publications but builds no key when their admitted content is unchanged', () => {
        const source = createPluginSurfaceContextFixture();
        const previous = preparePluginSurfaceContext(source);
        const parse = vi.spyOn(PluginUiHostApiSurfaceContextV1Schema, 'parse');
        const stringify = vi.spyOn(stableJson, 'stableJsonStringify');
        onTestFinished(() => { parse.mockRestore(); stringify.mockRestore(); });
        const publications = Array.from({ length: 100 }, () => preparePluginSurfaceContext({ ...source }, previous));
        expect(parse).toHaveBeenCalledTimes(100);
        expect(stringify).toHaveBeenCalledTimes(0);
        expect(publications.every(value => value === previous)).toBe(true);
        stringify.mockClear();
        const changed = preparePluginSurfaceContext({ ...source, locale: 'de' }, previous);
        expect(stringify).toHaveBeenCalledTimes(1);
        expect(changed.semanticKey).not.toBe(previous.semanticKey);
        expect(changed.surface.locale).toBe('de');
        expect(changed.surface.theme).toBe(previous.surface.theme);
        expect(() => preparePluginSurfaceContext({ ...source, textScale: -1 }, previous)).toThrow();
    });
    it('projects live local spinner preferences without subscribing to unrelated local settings', async () => {
        const previous = storage.getState();
        onTestFinished(() => { storage.setState(previous, true); });
        storage.setState({ localSettings: { ...previous.localSettings,
            loadingIndicatorStyle: 'hWave', loadingIndicatorSpeed: 'slow', loadingIndicatorPause: 'long',
        } });
        let renders = 0;
        const hook = await renderHook(() => {
            renders += 1;
            return usePluginSurfaceEnvironment('web');
        });
        onTestFinished(() => hook.unmount());
        const initial = hook.getCurrent();
        expect(initial.theme.spinner).toEqual({ style: 'hWave', speed: 'slow', pause: 'long' });
        const initialRenders = renders;
        await act(async () => {
            storage.setState({ localSettings: { ...storage.getState().localSettings,
                uiItemDensity: previous.localSettings.uiItemDensity === 'compact' ? 'comfortable' : 'compact',
            } });
        });
        expect(renders).toBe(initialRenders);
        expect(hook.getCurrent()).toBe(initial);
        await act(async () => {
            storage.setState({ localSettings: { ...storage.getState().localSettings,
                loadingIndicatorStyle: 'classicRing', loadingIndicatorSpeed: 'fast', loadingIndicatorPause: 'none',
            } });
        });
        expect(hook.getCurrent().theme.spinner).toEqual({ style: 'classicRing', speed: 'fast', pause: 'none' });
        expect(hook.getCurrent().reducedMotion).toBe(initial.reducedMotion);
    });
    it('projects the shell column visibility only for an app page', () => {
        const fixture = createPluginSurfaceContextFixture();
        const environment = {
            platform: fixture.platform,
            locale: fixture.locale,
            direction: fixture.direction,
            colorScheme: fixture.colorScheme,
            contrast: fixture.contrast,
            textScale: fixture.textScale,
            reducedMotion: fixture.reducedMotion,
            screenReaderEnabled: fixture.screenReaderEnabled,
            safeAreaInsets: fixture.safeAreaInsets,
            theme: fixture.theme,
            columnVisible: true,
        };
        const input = {
            target: { kind: 'app' as const },
            accountEncryptionMode: fixture.accountEncryptionMode,
            environment,
            translations: fixture.translations,
            targetedContributions,
        };
        const appPageMount = {
            kind: 'destination' as const,
            destination: { pluginId: 'acme.preview', localId: 'inbox' },
            container: 'appPage' as const,
        };
        expect(createPluginSurfaceContext({ ...input, mount: appPageMount }).page).toEqual({ columnVisible: true });
        expect(createPluginSurfaceContext({ ...input, mount: appPageMount, environment: { ...environment, columnVisible: false } }).page).toEqual({ columnVisible: false });
        expect(createPluginSurfaceContext({ ...input, mount: fixture.mount }).page).toBeUndefined();
    });

    it('projects the host-stamped mount and exact admitted target snapshot', () => {
        const fixture = createPluginSurfaceContextFixture();
        const targeted = createPluginSurfaceContext({
            mount: fixture.mount,
            target: fixture.target,
            accountEncryptionMode: fixture.accountEncryptionMode,
            environment: {
                platform: fixture.platform,
                locale: fixture.locale,
                direction: fixture.direction,
                colorScheme: fixture.colorScheme,
                contrast: fixture.contrast,
                textScale: fixture.textScale,
                reducedMotion: fixture.reducedMotion,
                screenReaderEnabled: fixture.screenReaderEnabled,
                safeAreaInsets: fixture.safeAreaInsets,
                theme: fixture.theme,
                columnVisible: false,
            },
            translations: fixture.translations,
            targetedContributions,
            machineConnectionPending: true,
            machineExecutionReady: false,
        });

        expect(targeted.mount).toBe(fixture.mount);
        expect(targeted.accountEncryptionMode).toBe(fixture.accountEncryptionMode);
        expect(targeted.targetedContributions).toBe(targetedContributions);
        // Both physical transports use this producer and the SDK's strict
        // context reader; pending is presentation, never surface inactivity.
        expect(PluginUiHostApiSurfaceContextV1Schema.parse(targeted)).toMatchObject({
            machineConnectionPending: true, machineExecutionReady: false,
        });
    });

});
