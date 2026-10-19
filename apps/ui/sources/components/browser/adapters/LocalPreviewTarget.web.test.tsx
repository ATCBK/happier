import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalServicePreviewResourceV1 } from '@happier-dev/protocol/local/services/preview/v1';
import { proxyLocalServicePreviewHttpRequest } from '@happier-dev/peer-mediation/localServices/preview/httpAdapter';

import { renderScreen } from '@/dev/testkit';

import { LocalPreviewTarget } from './LocalPreviewTarget.web';
import { createBrowserAutomationControlService } from '@/sync/domains/browser/automation/controlService';

afterEach(() => vi.unstubAllGlobals());

describe('LocalPreviewTarget web', () => {
    it.each([
        { url: 'https://preview.example.test/', collector: true },
        { url: 'https://preview.example.test/', collector: false },
        { url: 'https://app.example.test/v1/local-services/preview/preview/', collector: false },
    ])('shows the existing unavailable state for the real proxy refusal and recovers on reload: $url (collector=$collector)', async ({ url, collector }) => {
        vi.stubGlobal('window', new EventTarget());
        const identity = { browserSessionId: 'bs', viewId: 'v', navigationGeneration: 1, collectorId: 'c', nonce: 'n' };
        const diagnostics = { ...identity, collectorVersion: '1.0.0', sourceOrigin: 'https://preview.example.test', webPostMessageTargetOrigin: 'https://app.example.test', onEvents: vi.fn() };
        const automation = { ...identity, capabilityVersion: '1.0.0', adapterKind: 'localPreview', supportedActions: [], controlService: createBrowserAutomationControlService({ nowMs: Date.now }) };
        const preview: LocalServicePreviewResourceV1 = {
            previewId: 'preview', sessionId: 'session', machineId: 'machine', owner: { kind: 'session', id: 'session' },
            target: { scheme: 'http', host: '127.0.0.1', port: 5173 }, initialPath: { pathname: '/', search: '' },
            display: { title: 'Preview', addressLabel: 'localhost' }, originMode: 'host',
        };
        const lifecycle = vi.fn();
        let transportAvailable = false;
        const fetchBoundary = vi.fn(async (href: string) => {
            const url = new URL(href);
            const body: Uint8Array[] = [];
            let status = 0;
            // The HTTP boundary retains the real proxy refusal serializer. Successful collector
            // metadata is covered through the registered server route in httpTransport.test.ts.
            if (transportAvailable) return Object.defineProperty(new Response(JSON.stringify({ state: 'collector_available' })), 'url', { value: href });
            await proxyLocalServicePreviewHttpRequest({
                preview, request: { method: 'GET', path: url.pathname, search: url.search, headers: { host: url.host, origin: diagnostics.webPostMessageTargetOrigin } },
                response: { writeHead(code) { status = code; }, write(chunk) { body.push(chunk); }, end() {}, destroy() {} },
                openTunnel: async () => { throw new Error('transport unavailable'); },
            });
            const response = new Response(Buffer.concat(body).toString('utf8'), { status });
            Object.defineProperty(response, 'url', { value: href });
            return response;
        });
        vi.stubGlobal('fetch', fetchBoundary);
        const props = { title: 'Preview', url, testID: 'local-preview', ...(collector ? { diagnostics, automation } : {}), onLifecycle: lifecycle };
        const screen = await renderScreen(<LocalPreviewTarget {...props} />, { createNodeMock: element => element.type === 'iframe' ? { contentWindow: {} } : null });
        await act(async () => screen.findByType('iframe').props.onLoad());
        expect(screen.findHostByTestId('local-preview-unavailable')).not.toBeNull();
        expect(screen.findAllByType('iframe')).toHaveLength(0);
        expect(lifecycle).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'loadFailed' }));
        expect(fetchBoundary.mock.calls).toHaveLength(1);

        await screen.update(<LocalPreviewTarget {...props} navigationCommand={{ commandId: 'retry', kind: 'reload' }} />);
        expect(screen.findHostByTestId('local-preview-unavailable')).toBeNull();
        expect(screen.findAllByType('iframe')).toHaveLength(1);
        transportAvailable = true;
        await act(async () => screen.findByType('iframe').props.onLoad());
        expect(screen.findHostByTestId('local-preview-unavailable')).toBeNull();
        expect(lifecycle).toHaveBeenLastCalledWith({ kind: 'loadFinished', url: props.url });
    });

    it('feeds the preview documents\' own history and loading truth to the control lifecycle without moving the view\'s URL', async () => {
        const host = new EventTarget();
        vi.stubGlobal('window', host);
        const frame = {};
        const identity = { browserSessionId: 'bs', viewId: 'v', navigationGeneration: 1, collectorId: 'c', nonce: 'n' };
        const lifecycle = vi.fn();
        const screen = await renderScreen(<LocalPreviewTarget title="Preview" url="https://preview.example.test/" testID="local-preview" onLifecycle={lifecycle}
            diagnostics={{ ...identity, collectorVersion: '1.0.0', sourceOrigin: 'https://preview.example.test', webPostMessageTargetOrigin: 'https://app.example.test', onEvents: vi.fn() }}
            automation={{ ...identity, capabilityVersion: '1.0.0', sourceOrigin: 'https://preview.example.test', adapterKind: 'localPreview', supportedActions: [], controlService: createBrowserAutomationControlService({ nowMs: Date.now }) }} />,
        { createNodeMock: element => element.type === 'iframe' ? { contentWindow: frame } : null });
        const event = new Event('message') as MessageEvent;
        Object.defineProperties(event, {
            data: { value: JSON.stringify({ v: 1, kind: 'browser.collector.navigation', ...identity, loading: false, canGoBack: true, canGoForward: false, url: 'https://preview.example.test/other' }) },
            origin: { value: 'https://preview.example.test' }, source: { value: frame },
        });
        await act(async () => { host.dispatchEvent(event); });
        expect(lifecycle).toHaveBeenCalledWith({ kind: 'navigationStateChanged', loading: false, canGoBack: true, canGoForward: false });
        await screen.unmount();
    });

    it('keeps path-mode previews sandboxed without same-origin privileges', async () => {
        const screen = await renderScreen(
            <LocalPreviewTarget
                title="Preview"
                url="https://app.happier.test/v1/local-services/preview/preview_1/"
                testID="local-preview"
            />,
        );

        const iframe = screen.findByType('iframe');
        expect(iframe.props.sandbox).toContain('allow-scripts');
        expect(iframe.props.sandbox).not.toContain('allow-same-origin');
    });

    it('allows same-origin only for dedicated host-origin previews', async () => {
        const screen = await renderScreen(
            <LocalPreviewTarget
                title="Preview"
                url="https://preview-1.preview.happier.test/dashboard"
                testID="local-preview"
            />,
        );

        const iframe = screen.findByType('iframe');
        expect(iframe.props.sandbox).toContain('allow-same-origin');
    });
});
