import * as React from 'react';
import {
    BrowserEventV1Schema,
    type BrowserAdapterCapabilitiesV1,
    type BrowserCommandV1,
    type BrowserEventV1,
    type BrowserViewTargetV1,
} from '@happier-dev/protocol';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { initializeTerminalRouteRuntimeForTests, installTerminalRouteCommonModuleMocks } from '@/__tests__/routes/(app)/terminal/terminalRouteTestHelpers';
import type { BrowserDaemonControlCommandSender } from '@/sync/domains/browser/control/machineRpc';
import { BrowserShell } from '@/components/browser/BrowserShell';
import { BrowserPresenceCapsule } from '@/components/browser/copresence/BrowserPresenceCapsule';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { BrowserAutomationActionRequestV1Schema } from '@happier-dev/protocol/browser/automation/v1';
import { buildBrowserAdapterCapabilities } from '@/sync/domains/browser/adapters/capabilities';
import {
    applyBrowserControlEvent,
    createBrowserControlState,
    type BrowserControlState,
} from '@/sync/domains/browser/control';
import { clearBrowserRuntimeControlRegistryForTests } from '@/sync/domains/browser/actions/runtimeControlRegistry';
import { createDefaultRuntimeActionExecutor } from '@/sync/ops/actions/defaultRuntimeActionExecutor';
import { BrowserSurfaceHost } from './BrowserSurfaceHost';

installTerminalRouteCommonModuleMocks();
await initializeTerminalRouteRuntimeForTests();

let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let actionRequest: ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response | null>) | undefined;
beforeEach(async () => {
    actionRequest = undefined;
    connection = await restoreServerAccountForTest({ serverUrl: 'https://browser-control-home.example.test', serverIdentityId: 'srv_browser_fresh',
        credentials: { token: `e30.${Buffer.from(JSON.stringify({ sub: 'account-a', tokenEpoch: 1,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature` },
        request: async (input, init) => {
        const actionResponse = await actionRequest?.(input, init);
        if (actionResponse) return actionResponse;
        const path = new URL(String(input)).pathname;
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
        if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({ features: { browser: { enabled: true, internal: { enabled: true }, automation: { enabled: true }, viewTargets: { enabled: true } } } }));
        return new Response('{}', { status: 404 });
    } });
});

const target = {
    kind: 'localServicePreview',
    targetId: 'preview_1',
    sessionId: 'session_1',
    machineId: 'machine_1',
    display: {
        title: 'Preview',
        addressLabel: 'localhost:5173',
    },
} satisfies BrowserViewTargetV1;

function stateFromEvents(events: readonly BrowserEventV1[]): BrowserControlState {
    return events.reduce(
        (nextState, event) => applyBrowserControlEvent(nextState, event),
        createBrowserControlState(),
    );
}

function openViewState(input: Readonly<{
    browserSessionId: string;
    viewId: string;
    target: BrowserViewTargetV1;
    capabilities: BrowserAdapterCapabilitiesV1;
    currentUrl: string;
}>): BrowserControlState {
    return stateFromEvents([{
        kind: 'sessionCreated',
        eventId: 'event_session',
        browserSessionId: input.browserSessionId,
        profileId: 'profile_1',
        occurredAt: 1_000,
    }, {
        kind: 'viewOpened',
        eventId: 'event_view',
        browserSessionId: input.browserSessionId,
        viewId: input.viewId,
        target: input.target,
        platform: 'web',
        currentUrl: input.currentUrl,
        adapterKind: 'localPreview',
        engineKind: 'webIframe',
        adapterCapabilities: input.capabilities,
        occurredAt: 1_001,
    }, {
        kind: 'viewFocused',
        eventId: 'event_focus',
        browserSessionId: input.browserSessionId,
        viewId: input.viewId,
        occurredAt: 1_002,
    }]);
}

describe('BrowserSurfaceHost runtime control registration', () => {
    it('observes the current daemon page through the captured Account Action transport and waits for authoritative recovery', async () => {
        const requests: unknown[] = [];
        actionRequest = async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/machines') return Response.json([{ id: 'machine-fresh', kind: 'persistent',
                active: true, revokedAt: null, replacedByMachineId: null, metadata: null, metadataVersion: 0,
                access: { custodian: { accountId: 'account-a', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } }]);
            if (url.pathname !== '/v1/actions/browser.automation.snapshot') return null;
            expect(url.origin).toBe('https://browser-control-home.example.test');
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(JSON.parse(String(init?.body)));
            const request = BrowserAutomationActionRequestV1Schema.parse(envelope.input);
            requests.push({ target: envelope.target, request });
            return Response.json({ v: 1, actionId: 'browser.automation.snapshot', requestId: envelope.requestId,
                execution: { ok: true, result: { v: 1, automationRequestId: request.automationRequestId, status: 'succeeded',
                    adapterKind: 'chromiumSidecar', fidelity: 'cdp', trustedInput: true, durationMs: 0,
                    navigationGenerationBefore: 7, navigationGenerationAfter: 7, controlEpochBefore: 3, controlEpochAfter: 3 } } });
        };
        const local = openViewState({ browserSessionId: 'browser_fresh', viewId: 'view_fresh', target,
            currentUrl: 'https://preview.happier.test/', capabilities: buildBrowserAdapterCapabilities({
                adapterKind: 'chromiumSidecar', supportedTargetKinds: ['localServicePreview'], supportedRenderEngines: ['desktopWebView'],
            }) });
        const current = { ...local.viewsById.view_fresh!, adapterKind: 'chromiumSidecar' as const, engineKind: 'desktopWebView' as const,
            navigationGeneration: 7, automationController: { browserSessionId: 'browser_fresh', viewId: 'view_fresh',
                controller: 'human' as const, controlEpoch: 3, uncertain: true } };
        let publish: ((event: BrowserEventV1) => void) | undefined;
        const screen = await renderScreen(<BrowserSurfaceHost browserSessionId="browser_fresh" platform="desktop"
            initialBrowserState={{ ...local, viewsById: { view_fresh: current } }}
            pluginBrowserActionContext={{ machineId: 'machine-fresh', sessionId: 'session-fresh' }}
            subscribeBrowserEvents={listener => { publish = listener; return () => { publish = undefined; }; }}
            policy={{ browserEnabled: true, viewTargetsEnabled: true, diagnosticsEnabled: false,
                contextEnabled: false, automationEnabled: true, recordingEnabled: false }} testID="browser-fresh" />);
        await screen.pressByTestIdAsync('browser-fresh-presence-check-again');
        expect(requests).toEqual([expect.objectContaining({ target: { kind: 'machine', machineId: 'machine-fresh' },
            request: expect.objectContaining({ browserSessionId: 'browser_fresh', viewId: 'view_fresh', navigationGeneration: 7,
                actionKind: 'snapshot', requestedBy: 'user' }) })]);
        expect(screen.findByType(BrowserPresenceCapsule).props.presence).toMatchObject({ kind: 'human', interruptedCompletion: 'unknown' });
        await act(async () => publish?.({ kind: 'controllerChanged', eventId: 'observed', occurredAt: 1003,
            browserSessionId: 'browser_fresh', viewId: 'view_fresh', navigationGeneration: 7,
            state: { ...current.automationController, uncertain: false } }));
        expect(screen.findByType(BrowserPresenceCapsule).props.presence).toMatchObject({ kind: 'human', interruptedCompletion: null });
        const checkAgain = screen.findByType(BrowserShell).props.onCheckAgain;
        await screen.unmount();
        expect(await checkAgain({ browserSessionId: 'browser_fresh', viewId: 'view_fresh' }))
            .toMatchObject({ ok: false, errorCode: 'runtime_action_disabled' });
        expect(requests).toHaveLength(1);
    });
    it('refuses a fresh observation of a disappeared page without replaying a command', async () => {
        const initialBrowserState = openViewState({ browserSessionId: 'browser_fresh', viewId: 'view_fresh', target,
            currentUrl: 'https://preview.happier.test/', capabilities: buildBrowserAdapterCapabilities({
                adapterKind: 'localPreview', supportedTargetKinds: ['localServicePreview'], supportedRenderEngines: ['webIframe'],
            }) });
        const sendDaemonCommand = vi.fn<BrowserDaemonControlCommandSender>();
        const screen = await renderScreen(<BrowserSurfaceHost browserSessionId="browser_fresh" platform="web"
            initialBrowserState={initialBrowserState} sendDaemonCommand={sendDaemonCommand}
            policy={{ browserEnabled: true, viewTargetsEnabled: true, diagnosticsEnabled: false,
                contextEnabled: false, automationEnabled: true, recordingEnabled: false }} testID="browser-fresh" />);
        const shell = screen.findByType(BrowserShell);
        let result: unknown;
        await act(async () => { result = await shell.props.onCheckAgain({ browserSessionId: 'browser_fresh', viewId: 'gone' }); });
        expect(result).toMatchObject({ ok: false, errorCode: 'runtime_action_disabled' });
        expect(sendDaemonCommand).not.toHaveBeenCalled();
        expect(screen.findByType(BrowserShell).props.state).toEqual(initialBrowserState);
    });
    afterEach(async () => {
        await standardCleanup();
        await connection?.dispose();
        clearBrowserRuntimeControlRegistryForTests();
    });

    it('registers its control adapter so browser.navigate can execute through the default runtime bridge', async () => {
        const browserSessionId = 'browser_session_surface';
        const viewId = 'view_surface';
        const initialBrowserState = openViewState({
            browserSessionId,
            viewId,
            target,
            currentUrl: 'https://preview.happier.test/',
            capabilities: {
                ...buildBrowserAdapterCapabilities({
                    adapterKind: 'localPreview',
                    supportedTargetKinds: ['localServicePreview'],
                    supportedRenderEngines: ['webIframe'],
                }),
                navigation: {
                    canNavigate: true,
                    canGoBack: false,
                    canGoForward: false,
                    canReload: true,
                    canStop: true,
                },
            },
        });
        const screen = await renderScreen(
            <BrowserSurfaceHost
                browserSessionId={browserSessionId}
                platform="web"
                initialBrowserState={initialBrowserState}
                policy={{
                    browserEnabled: true,
                    viewTargetsEnabled: true,
                    diagnosticsEnabled: false,
                    contextEnabled: false,
                    automationEnabled: false,
                    recordingEnabled: false,
                }}
                testID="browser-surface"
            />,
        );
        await flushHookEffects();

        const execute = createDefaultRuntimeActionExecutor();
        let result: unknown;
        const command = {
            kind: 'navigate',
            commandId: 'command_surface_navigate',
            browserSessionId,
            viewId,
            url: 'https://preview.happier.test/surface',
        } satisfies BrowserCommandV1;
        await act(async () => {
            result = await execute({
                actionId: 'browser.navigate',
                input: command,
                context: {},
            });
        });
        await flushHookEffects();

        expect(result).toMatchObject({
            v: 1,
            commandId: 'command_surface_navigate',
            status: 'dispatched',
            adapterKind: 'localPreview',
            events: [],
        });
        const shell = screen.findByType(BrowserShell);
        expect(shell?.props.state.viewsById[viewId]?.pendingUrl).toBe('https://preview.happier.test/surface');
        expect(screen.findByType('iframe').props.src).toBe('https://preview.happier.test/surface');
    });

    it('routes daemon navigation and retains Close when unrelated Browser catalogs fail', async () => {
        const browserSessionId = 'browser_session_sidecar';
        const viewId = 'view_sidecar';
        const externalTarget = {
            kind: 'externalUrl',
            targetId: 'external_1',
            url: 'https://browser.example.test/start',
            display: { title: 'Browser', addressLabel: 'browser.example.test' },
        } satisfies BrowserViewTargetV1;
        const sidecarCapabilities = {
            ...buildBrowserAdapterCapabilities({
                adapterKind: 'chromiumSidecar',
                supportedTargetKinds: ['externalUrl'],
                supportedRenderEngines: ['desktopWebView'],
            }),
            navigation: {
                canNavigate: true,
                canGoBack: true,
                canGoForward: true,
                canReload: true,
                canStop: true,
            },
        } satisfies BrowserAdapterCapabilitiesV1;
        const initialBrowserState = stateFromEvents([{
            kind: 'sessionCreated',
            eventId: 'event_session',
            browserSessionId,
            profileId: 'profile_1',
            occurredAt: 1_000,
        }, {
            kind: 'viewOpened',
            eventId: 'event_view',
            browserSessionId,
            viewId,
            target: externalTarget,
            platform: 'desktop',
            currentUrl: 'https://browser.example.test/start',
            adapterKind: 'chromiumSidecar',
            engineKind: 'desktopWebView',
            adapterCapabilities: sidecarCapabilities,
            occurredAt: 1_001,
        }, {
            kind: 'viewFocused',
            eventId: 'event_focus',
            browserSessionId,
            viewId,
            occurredAt: 1_002,
        }]);

        const daemonReply = createDeferred<void>();
        const sendDaemonCommand = vi.fn<BrowserDaemonControlCommandSender>(async (command, onEvents) => {
            // The real sender awaits its daemon RPC before publishing response
            // events; hold that external reply until local dispatch has settled.
            await daemonReply.promise;
            const events = [BrowserEventV1Schema.parse(command.kind === 'closeView'
                ? { kind: 'viewClosed', eventId: 'event_closed', browserSessionId, viewId, occurredAt: 1_004 }
                : { kind: 'navigationCommitted', eventId: 'event_committed', browserSessionId, viewId,
                    currentUrl: command.kind === 'navigate' ? command.url : '', occurredAt: 1_003 })];
            onEvents?.(events);
            return { ok: true, result: { v: 1, commandId: command.commandId, status: 'dispatched', adapterKind: 'chromiumSidecar', events } };
        });
        const renderHost = (catalogFailed: boolean) => (
            <BrowserSurfaceHost
                browserSessionId={browserSessionId}
                platform="desktop"
                initialBrowserState={initialBrowserState}
                sendDaemonCommand={sendDaemonCommand}
                launchpadRefreshStatus={catalogFailed ? 'error' : 'idle'}
                launchpadRefreshError={catalogFailed ? 'local_service_preview_refresh_failed' : null}
                pluginUiInteractionEnabled={!catalogFailed}
                policy={{
                    browserEnabled: true,
                    viewTargetsEnabled: true,
                    diagnosticsEnabled: false,
                    contextEnabled: false,
                    automationEnabled: false,
                    recordingEnabled: false,
                }}
                testID="browser-surface"
            />
        );
        const screen = await renderScreen(renderHost(false));
        await flushHookEffects();

        const execute = createDefaultRuntimeActionExecutor();
        const command = {
            kind: 'navigate',
            commandId: 'command_sidecar_navigate',
            browserSessionId,
            viewId,
            url: 'https://browser.example.test/next',
        } satisfies BrowserCommandV1;
        let result: unknown;
        await act(async () => {
            const dispatched = execute({ actionId: 'browser.navigate', input: command, context: {} });
            daemonReply.resolve();
            result = await dispatched;
        });
        await flushHookEffects();

        expect(result).toMatchObject({
            v: 1,
            commandId: 'command_sidecar_navigate',
            status: 'dispatched',
            adapterKind: 'chromiumSidecar',
            events: [expect.objectContaining({ kind: 'navigationCommitted' })],
        });
        expect(result).not.toMatchObject({ error: 'runtime_action_disabled:browser:browser_control_route_unavailable' });
        expect(sendDaemonCommand).toHaveBeenCalledWith(command, expect.any(Function));
        await act(async () => {
            daemonReply.resolve();
            await sendDaemonCommand.mock.results[0]?.value;
        });
        await flushHookEffects();
        expect(screen.findByType(BrowserShell).props.state.viewsById[viewId]).toMatchObject({
            currentUrl: 'https://browser.example.test/next', pendingUrl: null,
        });
        expect(screen.findByTestId('browser-surface-address')?.props.value).toBe('browser.example.test/next');

        await screen.update(renderHost(true));
        expect(screen.findByType(BrowserShell).props.state.viewsById[viewId]).toMatchObject({
            currentUrl: 'https://browser.example.test/next',
        });
        const close = { kind: 'closeView', commandId: 'command_sidecar_close', browserSessionId, viewId } satisfies BrowserCommandV1;
        let closed: unknown;
        await act(async () => { closed = await execute({ actionId: 'browser.view.close', input: close, context: {} }); });
        await flushHookEffects();
        expect(closed).toMatchObject({ status: 'dispatched', events: [expect.objectContaining({ kind: 'viewClosed' })] });
        expect(screen.findByType(BrowserShell).props.state.viewsById[viewId]).toBeUndefined();
    });
});
