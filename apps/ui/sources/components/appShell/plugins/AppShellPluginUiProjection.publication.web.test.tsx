// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';

import {
    AppShellPluginUiProjectionValueProvider,
    useAppShellPluginUiDeclarationProjection,
    useAppShellPluginUiProjection,
    type AppShellPluginUiProjectionValue,
} from './AppShellPluginUiProjection';
import { subscribeCommittedAppShellPluginUiProjection } from './committedPluginUiProjection';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { projectPluginRegistrySourceDeclarationV1 } from '@happier-dev/protocol/registries';

it('keeps a family subscriber quiet through unrelated startup publications and delivers its changed family', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let renders = 0;
    let observed: unknown;
    const Probe = React.memo(function Probe() {
        observed = useAppShellPluginUiProjection(value => value.pluginUiProjection?.registrySourcesById);
        renders += 1;
        return null;
    });
    const value: AppShellPluginUiProjectionValue = {
        pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null,
        phase: 'current', interactionEnabled: true, machineId: null, serverId: null,
        platform: 'web', accountLifetime: null,
        reloadConnectedAccountProjection: () => {}, clientExecutableActivation: { status: 'ready' },
        reloadClientExecutables: () => {},
    };
    const render = async (next: AppShellPluginUiProjectionValue) => {
        await act(async () => root.render(
            <AppShellPluginUiProjectionValueProvider value={next}><Probe /></AppShellPluginUiProjectionValueProvider>,
        ));
    };
    try {
        await render(value);
        renders = 0;
        for (let generation = 1; generation <= 20; generation += 1) {
            await render({ ...value, connectedAccountProjectionRevision: generation,
                pluginUiProjection: { ...EMPTY_PLUGIN_UI_PROJECTION, generation } });
        }
        expect(renders).toBe(0);
        expect(observed).toBe(EMPTY_PLUGIN_UI_PROJECTION.registrySourcesById);
        const declaration = projectPluginRegistrySourceDeclarationV1({ pluginId: 'com.acme.sources', pluginVersion: '1.0.0',
            definition: { id: 'skills', title: 'Skills', format: 'git', kinds: ['skill'], url: 'https://github.com/acme/skills' } });
        const changed = Object.freeze({ [declaration.id]: declaration });
        await render({ ...value, pluginUiProjection: { ...EMPTY_PLUGIN_UI_PROJECTION, registrySourcesById: changed } });
        expect(renders).toBe(1);
        expect(observed).toBe(changed);
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});

it('keeps the committed declaration reader attached across executable-only diagnostic updates', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let declaration: AppShellPluginUiProjectionValue['pluginUiProjection'] = null;
    function Probe() {
        declaration = useAppShellPluginUiDeclarationProjection();
        return null;
    }
    const value: AppShellPluginUiProjectionValue = {
        pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null,
        phase: 'current', interactionEnabled: true, machineId: null, serverId: null,
        platform: 'web', accountLifetime: null, connectedAccountProjectionRevision: 1,
        reloadConnectedAccountProjection: () => {}, clientExecutableActivation: { status: 'ready' },
        reloadClientExecutables: () => {},
    };
    const render = async (next: AppShellPluginUiProjectionValue) => {
        await act(async () => root.render(
            <AppShellPluginUiProjectionValueProvider value={next}><Probe /></AppShellPluginUiProjectionValueProvider>,
        ));
    };
    let stop: (() => void) | undefined;
    try {
        await render(value);
        let publications = 0;
        stop = subscribeCommittedAppShellPluginUiProjection(() => { publications += 1; });
        await render({ ...value, connectedAccountProjectionRevision: 2,
            clientExecutableActivation: { status: 'establishing' } });
        expect(publications).toBe(0);
        expect(declaration).toBe(value.pluginUiProjection);
        const changed = { ...EMPTY_PLUGIN_UI_PROJECTION, generation: 2 };
        await render({ ...value, pluginUiProjection: changed });
        expect(declaration).toBe(changed);
        expect(publications).toBe(1);
    } finally {
        stop?.();
        await act(async () => root.unmount());
        container.remove();
    }
});

it('publishes a projection replacement once and withdraws the latest binding once on unmount', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const value: AppShellPluginUiProjectionValue = {
        pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null,
        phase: 'current', interactionEnabled: true, machineId: null, serverId: null,
        platform: 'web', accountLifetime: null,
        reloadConnectedAccountProjection: () => {}, clientExecutableActivation: { status: 'ready' },
        reloadClientExecutables: () => {},
    };
    const render = async (next: AppShellPluginUiProjectionValue) => {
        await act(async () => root.render(
            <AppShellPluginUiProjectionValueProvider value={next}>{null}</AppShellPluginUiProjectionValueProvider>,
        ));
    };
    let stop: (() => void) | undefined;
    let mounted = true;
    try {
        await render(value);
        let publications = 0;
        stop = subscribeCommittedAppShellPluginUiProjection(() => { publications += 1; });
        const changed = { ...value, pluginUiProjection: { ...EMPTY_PLUGIN_UI_PROJECTION, generation: 3 } };
        await render(changed);
        expect(publications).toBe(1);
        publications = 0;
        await render({ ...changed });
        expect(publications).toBe(0);
        await act(async () => root.unmount());
        mounted = false;
        expect(publications).toBe(1);
    } finally {
        stop?.();
        if (mounted) await act(async () => root.unmount());
        container.remove();
    }
});
