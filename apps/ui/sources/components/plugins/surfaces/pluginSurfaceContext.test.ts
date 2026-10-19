import { PluginUiHostApiSurfaceContextV1Schema, type PluginUiTargetedContributionsV1 } from '@happier-dev/protocol/plugins/ui';
import { act } from 'react';
import { describe, expect, it, onTestFinished } from 'vitest';

import { createPluginSurfaceContextFixture } from '@/dev/testkit/fixtures/pluginSurfaceContextFixture';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { storage } from '@/sync/domains/state/storage';

import { createPluginSurfaceContext, usePluginSurfaceEnvironment } from './pluginSurfaceContext';

const targetedContributions: PluginUiTargetedContributionsV1 = {
    target: {
        pluginId: 'acme.preview',
        occurrenceId: 'target-generation-a',
        sourceCustody: { kind: 'development', registeredRootId: 'preview-root' },
    },
    points: [],
};

describe('createPluginSurfaceContext', () => {
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
