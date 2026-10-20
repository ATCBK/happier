// @vitest-environment jsdom
import { act } from 'react';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { renderSurface as renderShellSurface } from '../surface.js';
import { refreshTriageListWindow } from '../window/mountedWindow.js';
import { createTriageEphemeralSharedScopeFixture } from '../window/ephemeralSharedScope.test-support.js';

/**
 * The whole surface could not read anything: no window was ever assembled and
 * the reader's durable state is unreachable too (`core/SURFACE.md` §6.2 state 6).
 *
 * This state used to replace the page — toolbar included — with a red title
 * over the host's bare code ("unavailable"), and offered Refresh whatever the
 * host said about whether a retry could work.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: PluginUiTestkit[] = [];

async function mountUnreadableShell(failure: PluginError): Promise<PluginUiTestkit> {
    const ephemeralSharedScope = createTriageEphemeralSharedScopeFixture();
    let fixture!: PluginUiTestkit;
    await act(async () => {
        fixture = await createPluginUiTestkit({
            identity: { instanceId: 'fixture-instance-unavailable', mountNonce: 'fixture-mount-unavailable' },
            authorPlugin: { id: 'happier.triage', version: '0.0.0' },
            surface: renderShellSurface,
            surfaceContext: createSurfaceContextFixture({
                mount: {
                    kind: 'destination',
                    destination: { pluginId: 'happier.triage', localId: 'triage' },
                    container: 'appPage',
                },
            }),
            adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope, overlays: true }),
            handlers: {
                publishCurrentUiContext: () => undefined,
                // Every read fails the same way: the list, the pins and the
                // saved views, so nothing about the reader is reachable.
                executeAction: async () => { throw failure; },
                replacePageLocation: ({ subPath }) => subPath,
            },
        });
    });
    mounted.push(fixture);
    await act(async () => {
        await refreshTriageListWindow('view', fixture.context.hostApi, ephemeralSharedScope);
    });
    return fixture;
}

afterEach(async () => {
    for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('a PRs & Issues page that could not read anything', () => {
    it('keeps its toolbar and says what failed in words, with the code behind Details', async () => {
        const shell = await mountUnreadableShell(new PluginError({ code: 'unavailable', retryable: true }));

        await expect(shell.getByText('The list could not be read')).resolves.toBeDefined();
        // The page is still the page: its name leads the same one header (lab `merged-offline`), and its lens and
        // its own Refresh stay.
        await expect(shell.getByText('PRs & Issues')).resolves.toBeDefined();
        await expect(shell.getByRole('button', { name: 'Refresh' })).resolves.toBeDefined();
        await expect(shell.getByRole('button', { name: 'More' })).resolves.toBeDefined();
        // The host's code is a diagnostic, never the sentence.
        await expect(shell.queryByText('unavailable')).resolves.toBeUndefined();
        await expect(shell.getByRole('button', { name: 'Details' })).resolves.toBeDefined();
        // A retry can work, so the state offers one beside the message.
        await expect(shell.getByRole('button', { name: 'Try again' })).resolves.toBeDefined();
    });

    it('offers no retry the host says cannot succeed', async () => {
        const shell = await mountUnreadableShell(new PluginError({ code: 'unsupported_method', retryable: false }));

        await expect(shell.getByText('The list could not be read')).resolves.toBeDefined();
        await expect(shell.queryByRole('button', { name: 'Try again' })).resolves.toBeUndefined();
        await expect(shell.getByRole('button', { name: 'Details' })).resolves.toBeDefined();
    });
});
