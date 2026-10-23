import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { PluginUiHostApiSurfaceContextV1Schema } from '@happier-dev/protocol/plugins/ui';
import * as React from 'react';
import { Linking } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { loadPluginUiHostSupport } from '@/components/plugins/hostApi/loadPluginUiHostSupport';
import { HostedHtmlSurfaceAdapter, type CallerHostedHtmlRuntime } from '@/components/ui/surfaces/hostedHtml/HostedHtmlSurfaceAdapter';
import { createSessionCallerHostedHtmlRequestController } from './sessionCallerHostedHtmlRequestController';
import {
    createActionExecutor,
    DEFAULT_ACTIONS_SETTINGS_V1,
    isApprovalRequiredByActionsSettings,
} from '@happier-dev/protocol';

const observations = vi.hoisted(() => ({ frames: [] as Record<string, unknown>[] }));
// Physical browser frame only; the real caller adapter and shared bridge remain exercised.
vi.mock('@/components/browser/frame/BrowserViewFrame.web', () => ({
    BrowserViewFrame: (props: Readonly<{ engine: Record<string, unknown> }>) => {
        observations.frames.push(props.engine);
        return React.createElement('BrowserViewFrame');
    },
}));

afterEach(() => { standardCleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); observations.frames = []; });

async function waitForCallerFrame() {
    // Await real lazy SDK initialization rather than spending the assertion's
    // polling budget on cold module transformation in the source harness.
    await act(async () => { await loadPluginUiHostSupport(); });
    await vi.waitFor(async () => {
        await act(async () => { await Promise.resolve(); });
        expect(observations.frames.at(-1)?.html).toEqual(expect.any(String));
    });
    return observations.frames.at(-1)!;
}

it('opens caller links only through a current frame activation without adding Host API methods', async () => {
    // Browser/OS external opening is the only additional mocked boundary.
    const opened = vi.fn();
    vi.stubGlobal('open', opened);
    const linked = vi.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    const runtime: CallerHostedHtmlRuntime = {
        serverIdentityId: 'home-a', accountId: 'account-a', accountEncryptionMode: 'plain', hostOrigin: 'https://app.example.com',
        admittedHostMethods: ['context', 'watchContext'],
        createRequestController: () => ({ handleRequest: async () => null, dispose: () => undefined }),
        lifetime: { isCurrent: () => true, onRetire: () => ({ dispose: () => undefined }) },
    };
    await renderScreen(<HostedHtmlSurfaceAdapter
        title="links" recordRevision="revision-a" approvalSubject="links"
        source={artifactHtmlBundleFromBodyV1('<a href="https://example.test/read">Read</a>')}
        target={{ kind: 'app' }} runtime={runtime} testID="links-html"
    />);
    const frame = await waitForCallerFrame();
    const encoded = String(frame.html).match(/Object\.freeze\((\{.*?\})\),writable:false/)?.[1];
    if (!encoded) throw new Error('expected_inline_frame_bootstrap');
    const { identity } = JSON.parse(encoded) as { identity: { instanceId: string; mountNonce: string } };
    const transport = frame.webMessageBridge as Readonly<{
        onMessage: (event: MessageEvent, receipt: { consumeTransientActivation(): boolean }) => unknown;
    }>;
    const send = (sequence: number, kind: string, payload: unknown, trusted = false) => transport.onMessage(
        { data: { version: 1, identity, sequence, kind, payload }, origin: 'null' } as MessageEvent,
        { consumeTransientActivation: () => trusted },
    );
    await act(async () => { await send(1, 'ready', { ready: true }); });
    await send(2, 'openExternal', { url: 'https://example.test/read' });
    expect(opened.mock.calls.length + linked.mock.calls.length).toBe(0);
    expect(await send(3, 'openExternal', { url: 'https://example.test/read' }, true)).toMatchObject({ kind: 'ack' });
    expect(opened.mock.calls.length + linked.mock.calls.length).toBe(1);
    expect((opened.mock.calls[0] ?? linked.mock.calls[0])?.[0]).toBe('https://example.test/read');
    const negotiated = await send(4, 'hostApi', { wireVersion: 1, kind: 'negotiate', identity, apiRange: '^1.0.0' });
    expect(negotiated).toMatchObject({ payload: { methods: ['context', 'watchContext'] } });
});

it('replays the stored executable while each guest Action still requires the viewer approval owner', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'viewer-approval' }));
    // Persisting approval/mutation is the external boundary; keep the policy,
    // Action executor, request controller and guest bridge real.
    const sessionBoardAction = vi.fn(async () => { throw new Error('mutation_must_wait_for_approval'); });
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({
        sessionBoardAction,
        approvalsCreate,
        isApprovalExecutionOriginCurrent: async () => true,
        isActionApprovalRequired: (actionId, context) => isApprovalRequiredByActionsSettings(
            actionId, DEFAULT_ACTIONS_SETTINGS_V1, context,
        ),
    }));
    const runtime: CallerHostedHtmlRuntime = {
        serverIdentityId: 'viewer-home', accountId: 'viewer-account', accountEncryptionMode: 'plain', hostOrigin: 'https://app.example.com',
        admittedHostMethods: ['executeAction'],
        createRequestController: (publishResourceEvent) => createSessionCallerHostedHtmlRequestController({
            sessionId: 'session-a', serverId: 'viewer-home', serverIdentityId: 'viewer-home', accountId: 'viewer-account',
            executeHostAction: (actionId, input, context) => executor.execute(actionId, input, context),
            isAccountCurrent: () => true, isSessionCurrent: () => true, pluginTarget: null,
            publishResourceEvent, notify: () => undefined,
        }),
        lifetime: { isCurrent: () => true, onRetire: () => ({ dispose: () => undefined }) },
    };
    const screen = await renderScreen(<HostedHtmlSurfaceAdapter
        sessionId="session-a" title="stored visual" recordRevision="revision-a" approvalSubject="stored-item"
        source={artifactHtmlBundleFromBodyV1('<main>stored</main>')}
        requestedCapabilities={{ hostMethods: ['executeAction'], actions: ['session.board.item.remove'], network: 'open' }}
        target={{ kind: 'session', sessionId: 'session-a' }} runtime={runtime} testID="request-html"
    />);
    expect(screen.findByTestId('request-html-approval')).toBeNull();
    const frame = await waitForCallerFrame();
    const encoded = String(frame.html).match(/Object\.freeze\((\{.*?\})\),writable:false/)?.[1];
    if (!encoded) throw new Error('expected_inline_frame_bootstrap');
    const { identity } = JSON.parse(encoded) as { identity: { instanceId: string; mountNonce: string } };
    const transport = frame.webMessageBridge as Readonly<{
        onMessage: (event: MessageEvent, receipt: { consumeTransientActivation(): boolean }) => unknown;
    }>;
    const send = (sequence: number, kind: string, payload: unknown) => transport.onMessage(
        { data: { version: 1, identity, sequence, kind, payload }, origin: 'null' } as MessageEvent,
        { consumeTransientActivation: () => false },
    );
    await act(async () => {
        await send(1, 'ready', { ready: true });
        await send(2, 'hostApi', { wireVersion: 1, kind: 'negotiate', identity, apiRange: '^1.0.0' });
    });
    await expect(send(3, 'hostApi', {
        wireVersion: 1, kind: 'request', identity, requestId: 'remove-item', method: 'executeAction',
        payload: { action: 'session.board.item.remove', input: {
            sessionId: 'session-a', itemId: 'stored-item', expectedItemRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ',
        } },
    })).resolves.toMatchObject({ kind: 'result', payload: { kind: 'result', result: {
        kind: 'approval_request_created', artifactId: 'viewer-approval',
    } } });
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({
        executionOriginV1: expect.objectContaining({ authority: 'account_automation', accountId: 'viewer-account' }),
    }) }));
    expect(sessionBoardAction).not.toHaveBeenCalled();
});

it('keeps a live caller frame connected across an equivalent parent render', async () => {
    const runtime: CallerHostedHtmlRuntime = {
        serverIdentityId: 'home-a', accountId: 'account-a', accountEncryptionMode: 'plain', hostOrigin: 'https://app.example.com',
        admittedHostMethods: ['context', 'watchContext'],
        createRequestController: () => ({ handleRequest: async () => null, dispose: () => undefined }),
        lifetime: { isCurrent: () => true, onRetire: () => ({ dispose: () => undefined }) },
    };
    const source = artifactHtmlBundleFromBodyV1('<main>same document</main>');
    const requestedCapabilities = { hostMethods: ['context', 'watchContext'] };
    const render = () => <HostedHtmlSurfaceAdapter
        sessionId="session-a" title="same title" recordRevision="revision-a"
        approvalSubject="same-source" source={source} requestedCapabilities={requestedCapabilities}
        input={{ period: 'week' }}
        target={{ kind: 'session', sessionId: 'session-a' }}
        runtime={runtime} testID="probe-html"
    />;
    const screen = await renderScreen(render());
    const firstFrame = await waitForCallerFrame();
    const posted: unknown[] = [];
    const transport = firstFrame.webMessageBridge as Readonly<{
        attachHostMessages: (send: (message: unknown) => void) => (() => void);
    }>;
    const detach = transport.attachHostMessages((message) => posted.push(message));
    await screen.update(render());
    expect(observations.frames.at(-1)!.html).toBe(firstFrame.html);
    detach();
    expect(posted).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ payload: expect.objectContaining({ kind: 'disconnected' }) }),
    ]));
});

it('bootstraps caller HTML with the canonical host environment before reveal', async () => {
    const runtime: CallerHostedHtmlRuntime = {
        serverIdentityId: 'home-a', accountId: 'account-a', accountEncryptionMode: 'plain', hostOrigin: 'https://app.example.com',
        admittedHostMethods: ['context', 'watchContext'],
        createRequestController: () => ({ handleRequest: async () => null, dispose: () => undefined }),
        lifetime: { isCurrent: () => true, onRetire: () => ({ dispose: () => undefined }) },
    };
    await renderScreen(<HostedHtmlSurfaceAdapter
        sessionId="session-a" title="environment" recordRevision="revision-a"
        approvalSubject="environment-source" source={artifactHtmlBundleFromBodyV1('<main>environment</main>')}
        requestedCapabilities={{ hostMethods: ['context', 'watchContext'] }}
        target={{ kind: 'session', sessionId: 'session-a' }}
        runtime={runtime} testID="environment-html"
    />);
    const frame = await waitForCallerFrame();
    const encoded = String(frame.html).match(/Object\.freeze\((\{.*?\})\),writable:false/)?.[1];
    if (!encoded) throw new Error('expected_inline_frame_bootstrap');
    const { identity } = JSON.parse(encoded) as { identity: { instanceId: string; mountNonce: string } };
    const transport = frame.webMessageBridge as Readonly<{
        attachHostMessages: (send: (message: unknown) => void) => (() => void);
        onMessage: (event: MessageEvent, receipt: { consumeTransientActivation(): boolean }) => unknown;
    }>;
    const posted: Array<{ payload?: { kind?: string; surface?: Record<string, unknown> } }> = [];
    const detach = transport.attachHostMessages((message) => posted.push(message as never));
    const receipt = { consumeTransientActivation: () => false };
    const send = async (sequence: number, kind: string, payload: unknown) => await transport.onMessage(
        { data: { version: 1, identity, sequence, kind, payload }, origin: 'null' } as MessageEvent,
        receipt,
    );
    await send(1, 'ready', { ready: true });
    // Negotiation establishes the API; actual context reads own environment facts.
    const negotiated = await send(2, 'hostApi', { wireVersion: 1, kind: 'negotiate', identity, apiRange: '^1.0.0' }) as
        { payload?: { kind?: string; surface?: Record<string, unknown> } };
    expect(negotiated.payload?.kind).toBe('negotiated');
    expect(negotiated.payload).not.toHaveProperty('surface');
    const context = await send(3, 'hostApi', {
        wireVersion: 1, kind: 'request', identity, requestId: 'environment-context', method: 'context',
    }) as { payload?: { result?: { surface?: Record<string, unknown> } } };
    const surface = context.payload!.result!.surface!;
    // The same environment facts every installed surface receives, from the one producer.
    expect(surface).toMatchObject({
        direction: expect.stringMatching(/^(ltr|rtl)$/),
        colorScheme: expect.stringMatching(/^(light|dark)$/),
        contrast: expect.stringMatching(/^(normal|high)$/),
        textScale: expect.any(Number),
        reducedMotion: expect.any(Boolean),
        locale: expect.any(String),
        safeAreaInsets: expect.objectContaining({ top: expect.any(Number) }),
        theme: expect.any(Object),
    });
    // The actual context reader must admit the complete host environment.
    expect(PluginUiHostApiSurfaceContextV1Schema.safeParse(surface).success).toBe(true);
    expect(surface).toMatchObject({
        mount: { kind: 'embedded', role: 'callerHostedHtml', presentation: 'content' },
        target: { kind: 'session', sessionId: 'session-a' },
        accountEncryptionMode: 'plain',
        translations: {},
    });
    detach();
});
