import { describe, expect, it, vi } from 'vitest';
import { createCallerHostedHtmlHostApiBridgeHandler } from './hostedWebAdapter';
import { createSessionCallerHostedHtmlRequestController } from '@/components/ui/surfaces/hostedHtml/sessionCallerHostedHtmlRequestController';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';

/**
 * The wire envelope owns a Resource subscription's identity. The real bridge,
 * caller request controller and local watch owner run here; only the daemon
 * Resource RPC is a boundary.
 */
describe('hosted web bridge subscription identity', () => {
it('keeps the wire subscription identity authoritative over guest payload and closes its real watch', async () => {
    const identity = { instanceId: 'review-frame', mountNonce: 'review-nonce' };
    const digest = `sha256:${'a'.repeat(64)}` as const;
    const close = vi.fn(async () => undefined);
    const open = vi.fn(async () => ({
        supported: true as const,
        result: { ok: true as const, subscriptionId: 'wire-owned', digest },
    }));
    const controller = createSessionCallerHostedHtmlRequestController({
        sessionId: 'session-review', serverId: 'home-review', serverIdentityId: 'home-review', accountId: 'account-review',
        executeHostAction: async () => ({ ok: true, result: null }),
        isAccountCurrent: () => true, isSessionCurrent: () => true,
        pluginTarget: {
            machineId: 'machine-review', serverId: 'home-review', generation: 1, isCurrent: () => true,
            projection: {
                ...EMPTY_PLUGIN_UI_PROJECTION,
                generation: 1,
                installedPackagesById: {
                    'acme.preview': { id: 'acme.preview', displayName: 'Preview', enabled: true,
                        source: { kind: 'localPath', locator: 'acme.preview' }, occurrenceId: 'occurrence-review' },
                },
                resourcesById: {
                    'acme.preview/status': { id: 'status', pluginId: 'acme.preview', resourceKind: 'config',
                        scope: 'global', path: 'status.json', digest, contentType: 'application/json' },
                },
            },
        },
        publishResourceEvent: () => undefined, notify: () => undefined,
        // Genuine daemon Resource RPC boundary: the bridge and both local watch owners stay real.
        watchResource: {
            open, close,
            next: async (_machineId, input) => await new Promise((resolve) => {
                input.signal?.addEventListener('abort', () => resolve({ supported: false, reason: 'aborted' }), { once: true });
            }),
        },
    });
    const bridge = createCallerHostedHtmlHostApiBridgeHandler({
        callerAuthority: { kind: 'callerHostedHtml', sessionId: 'session-review', recordRevision: 'revision-review' },
        requestIdPrefix: 'review', identity,
        handleRequest: controller.handleRequest,
        canonicalHostApi: { identity, surface: {}, methods: ['watchResource'], activity: { active: true } },
        readInstalledMethods: () => ['watchResource'], postToFrame: () => undefined,
        isCurrent: () => true,
    });
    let sequence = 0;
    const send = async (kind: string, payload: unknown) => await bridge({
        version: 1, direction: 'frameToHost', identity, sequence: ++sequence, kind, payload,
    } as Parameters<typeof bridge>[0]);
    const dispatch = async (payload: unknown) => await send('hostApi', payload);
    try {
        // The canonical lifecycle: the frame reports ready before it negotiates.
        await send('ready', { ready: true });
        const negotiated = await dispatch({ wireVersion: 1, kind: 'negotiate', identity, apiRange: '^1.0.0' });
        const subscribed = await dispatch({ wireVersion: 1, kind: 'subscribe', identity, requestId: 'watch-request',
            subscriptionId: 'wire-owned', method: 'watchResource',
            payload: { subscriptionId: 'payload-override', resource: { pluginId: 'acme.preview', localId: 'status' } } });
        const disposed = await dispatch({ wireVersion: 1, kind: 'disposeHostResource', identity,
            requestId: 'dispose-request', subscriptionId: 'wire-owned' });
        expect(negotiated).toMatchObject({ kind: 'result' });
        // The admitted subscription is the one the envelope named, not the payload's.
        expect(subscribed).toMatchObject({ kind: 'result', payload: { result: { subscriptionId: 'wire-owned' } } });
        expect(disposed).toMatchObject({ kind: 'ack' });
        expect(open).toHaveBeenCalled();
        expect(close).toHaveBeenCalled();
    } finally {
        bridge.dispose();
        controller.dispose();
    }
});
});
