import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { createServer as createHttpsServer } from "node:https";
import tls from "node:tls";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { LocalServicePreviewResourceV1 } from "@happier-dev/protocol";
import { proxyLocalServicePreviewHttpRequest, type OpenLocalServicePreviewTunnel } from "./httpAdapter";
import { registerLocalServicePreviewRoutes } from "@/app/api/routes/local/services/preview/registerRoutes";
import { registerLocalServicePublicRoutes } from "@/app/api/routes/local/services/public/registerRoutes";
import { proxyLocalServicePreviewWebSocketUpgrade } from "./websocketAdapter";
import { runInNewContext } from 'node:vm';

const servers: Server[] = [];
afterEach(async () => {
    for (const server of servers.splice(0)) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

async function upstream(handler: (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => void) {
    const server = createServer(handler);
    return listenUpstream(server, "http");
}

async function listenUpstream(server: Server, scheme: "http" | "https", host = "127.0.0.1") {
    servers.push(server);
    server.listen(0, host);
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing TCP address");
    const preview: LocalServicePreviewResourceV1 = {
        previewId: "preview_transport", sessionId: "session", machineId: "machine",
        owner: { kind: "session", id: "session" },
        target: { scheme, host, port: address.port },
        initialPath: { pathname: "/", search: "" }, display: { title: "fixture", addressLabel: "fixture" }, originMode: "host",
    };
    const openTunnel: OpenLocalServicePreviewTunnel = async () => {
        const socket = connect(address.port, host);
        await once(socket, "connect");
        return {
            tunnelId: "tcp", substreamId: "stream",
            write: (bytes) => new Promise<void>((resolve, reject) => socket.write(bytes, (error) => error ? reject(error) : resolve())),
            endWrite: () => { socket.end(); },
            read: () => socket,
            close: () => { socket.destroy(); },
            abort: () => { socket.destroy(); },
        };
    };
    return { preview, openTunnel };
}

async function proxy(fixture: Awaited<ReturnType<typeof upstream>>, headers: IncomingHttpHeaders = {}, externalProtocol: "http" | "https" = "http") {
    let status = 0;
    let responseHeaders: Readonly<Record<string, string | readonly string[]>> = {};
    let failure: unknown;
    const bytes: Uint8Array[] = [];
    const request = { method: "GET", path: "/", search: "", headers, externalProtocol };
    const result = await proxyLocalServicePreviewHttpRequest({
        ...fixture,
        request,
        response: {
            writeHead(code, _message, headers) { status = code; responseHeaders = headers; }, write(chunk) { bytes.push(chunk); }, end() {}, destroy(error) { failure = error; },
        },
    });
    return { result, status, body: Buffer.concat(bytes), failure, headers: responseHeaders };
}

async function echoRequest(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) {
    try {
        const body: Uint8Array[] = [];
        for await (const chunk of request) body.push(chunk);
        response.end(Buffer.concat(body));
    } catch (error) {
        // A malformed upload is observable at the real TCP boundary, not an unhandled fixture promise.
        response.destroy(error instanceof Error ? error : new Error(String(error)));
    }
}

describe("preview native HTTP transport", () => {
    it.each([
        { collector: true, configured: true, publicExposure: false },
        { collector: false, configured: true, publicExposure: false },
        { collector: false, configured: false, publicExposure: false },
        { collector: false, configured: false, publicExposure: true },
    ])('preserves only the proxy transport refusal through the metadata probe (collector=$collector, configured=$configured, public=$publicExposure)', async ({ collector, configured, publicExposure }) => {
        const fixture = await upstream((_request, response) => {
            response.writeHead(503, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ error: 'preview_transport_unavailable', reasonCode: 'pms_tunnel_unavailable', privateDetail: 'do not disclose' }));
        });
        const config = { browserSessionId: 'bs', viewId: 'v', navigationGeneration: 1,
            collector: { collectorId: 'c', nonce: 'n', version: '1.0.0' }, webPostMessageTargetOrigin: 'https://app.example.test' };
        const app = Fastify();
        app.decorate('authenticate', async () => {});
        let transportAvailable = false;
        if (publicExposure) registerLocalServicePublicRoutes(app as never, {
            resolvePreview: () => fixture.preview,
            createExposure: () => ({ ok: false, reasonCode: 'public_origin_unavailable' }),
            revokeExposure: () => ({ ok: true }),
            validateAccess: () => ({ ok: true, preview: fixture.preview }),
        });
        else registerLocalServicePreviewRoutes(app as never, { resolvePreview: () => fixture.preview,
            resolvePreviewByHost: () => fixture.preview, hostOriginBaseDomain: 'example.test',
            validateAccess: () => ({ ok: true }), ...(configured ? { openTunnel: async (input: Parameters<OpenLocalServicePreviewTunnel>[0]) => {
                if (!transportAvailable) throw new Error('transport unavailable');
                return fixture.openTunnel(input);
            } } : {}) });
        try {
            const request = { method: 'GET' as const, url: `${publicExposure ? '/v1/local-services/public/exposure/' : '/'}?${collector ? `__happierCollector=${encodeURIComponent(JSON.stringify(config))}&` : ''}__happierCollectorState=1`,
                headers: { host: 'preview.example.test', origin: config.webPostMessageTargetOrigin } };
            const refused = await app.inject(request);
            expect(refused.statusCode).toBe(503);
            expect(refused.json()).toEqual({ error: 'preview_transport_unavailable', reasonCode: 'pms_tunnel_unavailable' });
            expect(refused.headers['access-control-allow-origin']).toBe(config.webPostMessageTargetOrigin);
            expect(refused.headers['access-control-allow-credentials']).toBe('true');
            if (!configured) return;
            transportAvailable = true;
            const applicationFailure = await app.inject(request);
            expect(applicationFailure.statusCode).toBe(200);
            expect(applicationFailure.json()).toEqual({ state: 'runtime_unavailable' });
            expect(applicationFailure.body).not.toContain('do not disclose');
        } finally { await app.close(); }
    });

    it("bootstraps only cooperative HTML navigations, preserves CSP and decodes upstream gzip", async () => {
        const { gzipSync } = await import("node:zlib");
        const html = '<!doctype html><html><head><title>Preview</title></head><body>café</body></html>';
        let upstreamSearch = "";
        let acceptEncoding = "";
        const fixture = await upstream((request, response) => {
            upstreamSearch = request.url ?? "";
            acceptEncoding = String(request.headers["accept-encoding"]);
            response.setHeader("Content-Type", "text/html; charset=utf-8");
            response.setHeader("Content-Security-Policy", "script-src 'self'");
            response.setHeader("Content-Encoding", "gzip");
            response.end(gzipSync(html));
        });
        const config = { browserSessionId: "bs", viewId: "v", navigationGeneration: 1,
            collector: { collectorId: "c", nonce: "pane_nonce", version: "1.0.0" }, webPostMessageTargetOrigin: "https://app.example.test" };
        const bytes: Uint8Array[] = [];
        let headers: Readonly<Record<string, string | readonly string[]>> = {};
        const result = await proxyLocalServicePreviewHttpRequest({ ...fixture,
            request: { method: "GET", path: "/", search: `?app=1&__happierCollector=${encodeURIComponent(JSON.stringify(config))}`, headers: { host: "preview.example.test", "sec-fetch-dest": "iframe" } },
            response: { writeHead(_code, _message, value) { headers = value; }, write(chunk) { bytes.push(chunk); }, end() {}, destroy() {} },
        });
        expect(result).toEqual({ ok: true });
        expect(acceptEncoding).toBe("identity");
        expect(upstreamSearch).toBe("/?app=1");
        expect(headers["content-security-policy"]).toBe("script-src 'self'");
        expect(headers["content-encoding"]).toBeUndefined();
        expect(headers["content-length"]).toBeUndefined();
        expect(Buffer.concat(bytes).toString()).toContain('/__happier/collector-loader.js?n=pane_nonce');
        expect(Buffer.concat(bytes).toString()).toContain('café');
        expect((await proxy(fixture)).body.equals(gzipSync(html))).toBe(true);
    });

    it.each([
        { policy: "script-src 'none'", meta: '' },
        { policy: "default-src 'none'", meta: '' },
        { policy: "script-src 'self'; script-src-elem 'none'", meta: '' },
        { policy: "script-src 'self'; sandbox allow-scripts", meta: '' },
        { policy: "script-src 'nonce-page' 'strict-dynamic' 'self'", meta: '' },
        { policy: "script-src 'self'", meta: '<meta http-equiv="Content-Security-Policy" content="script-src &#39;none&#39;">' },
    ])("reports a typed cooperative collector refusal without weakening CSP: $policy $meta", async ({ policy, meta }) => {
        const fixture = await upstream((_request, response) => {
            response.setHeader("Content-Type", "text/html");
            response.setHeader("Content-Security-Policy", policy);
            response.end(`<html><head>${meta}</head><body>blocked</body></html>`);
        });
        const config = { browserSessionId: "bs", viewId: "v", navigationGeneration: 1,
            collector: { collectorId: "c", nonce: "nonce", version: "1.0.0" }, webPostMessageTargetOrigin: "https://app.example.test" };
        let headers: Readonly<Record<string, string | readonly string[]>> = {};
        const bytes: Uint8Array[] = [];
        await proxyLocalServicePreviewHttpRequest({ ...fixture,
            request: { method: "GET", path: "/", search: `?__happierCollector=${encodeURIComponent(JSON.stringify(config))}`, headers: { host: "preview.example.test" } },
            response: { writeHead(_code, _message, value) { headers = value; }, write(chunk) { bytes.push(chunk); }, end() {}, destroy() {} },
        });
        expect(headers["x-happier-collector-state"]).toBe("collector_blocked_by_csp");
        expect(headers["content-security-policy"]).toBe(policy);
        expect(Buffer.concat(bytes).toString()).not.toContain("collector-loader.js");
        expect(Buffer.concat(bytes).toString()).toContain(meta);
    });

    it('serves cooperative real loader bytes behind preview access, executes the shared collector and probes CSP state', async () => {
        let requests = 0;
        const fixture = await upstream((_request, response) => {
            requests += 1;
            response.setHeader('Content-Type', 'text/html');
            response.setHeader('Content-Security-Policy', "script-src 'self'");
            response.end('<html><head></head><body><button id="button">Click</button></body></html>');
        });
        const config = { browserSessionId: 'bs', viewId: 'v', navigationGeneration: 1,
            collector: { collectorId: 'c', nonce: 'pane_nonce', version: '1.0.0' }, webPostMessageTargetOrigin: 'https://app.example.test' };
        const query = `__happierCollector=${encodeURIComponent(JSON.stringify(config))}`;
        const app = Fastify();
        app.decorate('authenticate', async () => {});
        registerLocalServicePreviewRoutes(app as never, { ...fixture, resolvePreview: () => fixture.preview,
            resolvePreviewByHost: (host) => host === 'preview.example.test' ? fixture.preview : null,
            hostOriginBaseDomain: 'example.test', validateAccess: ({ rawToken }) => rawToken === 'authorized' ? { ok: true } : { ok: false, reasonCode: 'token_invalid' } });
        const headers = { host: 'preview.example.test', cookie: 'happier_preview_token=authorized' };
        try {
            const navigation = await app.inject({ method: 'GET', url: `/?${query}`, headers });
            expect(navigation.statusCode).toBe(200);
            const { parse } = await import('parse5');
            const tree = parse(navigation.body);
            const html = tree.childNodes.find((node) => 'tagName' in node && node.tagName === 'html');
            if (!html || !('childNodes' in html)) throw new Error('HTML missing');
            const head = html.childNodes.find((node) => 'tagName' in node && node.tagName === 'head');
            if (!head || !('childNodes' in head)) throw new Error('head missing');
            const script = head.childNodes.find((node) => 'tagName' in node && node.tagName === 'script');
            if (!script || !('attrs' in script)) throw new Error('cooperative loader missing');
            const src = script.attrs.find((attr) => attr.name === 'src')?.value;
            if (!src) throw new Error('loader src missing');
            const loaderUrl = new URL(src, 'http://preview.example.test');
            expect(loaderUrl.origin).toBe('http://preview.example.test');
            const loader = await app.inject({ method: 'GET', url: loaderUrl.pathname + loaderUrl.search, headers });
            expect(loader.statusCode).toBe(200);
            expect(loader.headers['content-type']).toContain('javascript');
            expect(requests).toBe(1);
            const button = Object.assign(new EventTarget(), { getAttribute: () => null, innerText: 'Click' });
            let clicks = 0;
            button.addEventListener('click', () => { clicks += 1; });
            const parent = { postMessage: (data: string) => messages.push(JSON.parse(data)) };
            const messages: Array<Record<string, unknown>> = [];
            const guest = Object.assign(new EventTarget(), { parent, location: { href: 'http://preview.example.test/' },
                localStorage: { length: 0 }, sessionStorage: { length: 0 } });
            runInNewContext(loader.body, { window: guest, document: { title: 'Preview', readyState: 'complete',
                documentElement: { nodeType: 1 }, querySelectorAll: (selector: string) => selector === '#button' ? [button] : [] },
                console: { log() {}, info() {}, warn() {}, error() {}, debug() {} }, performance: { getEntriesByType: () => [] }, Event });
            expect(messages).toContainEqual({ v: 1, kind: 'browser.collector.ready', browserSessionId: 'bs', viewId: 'v', navigationGeneration: 1, collectorId: 'c', nonce: 'pane_nonce' });
            const command = { v: 1, kind: 'browser.injectedRuntime.command', runtimeId: 'bs:v:1', browserSessionId: 'bs', viewId: 'v', navigationGeneration: 1,
                collectorId: 'c', nonce: 'pane_nonce', module: 'automation', capabilityVersion: '1.0.0', commandId: 'click', commandName: 'click', payload: { locator: { kind: 'css', value: '#button' } } };
            const send = (origin: string, source: unknown) => {
                const event = new Event('message');
                Object.defineProperties(event, { data: { value: JSON.stringify(command) }, origin: { value: origin }, source: { value: source } });
                guest.dispatchEvent(event);
            };
            send('https://evil.example.test', parent);
            send(config.webPostMessageTargetOrigin, guest);
            expect(clicks).toBe(0);
            send(config.webPostMessageTargetOrigin, parent);
            expect(clicks).toBe(1);
            const denied = await app.inject({ method: 'GET', url: loaderUrl.pathname + loaderUrl.search, headers: { host: headers.host } });
            expect(denied.statusCode).toBe(401);
            const mismatch = new URL(loaderUrl); mismatch.searchParams.set('n', 'wrong');
            expect((await app.inject({ method: 'GET', url: mismatch.pathname + mismatch.search, headers })).statusCode).toBe(400);
            const probe = await app.inject({ method: 'GET', url: `/?${query}&__happierCollectorState=1`, headers: { ...headers, origin: config.webPostMessageTargetOrigin } });
            expect(probe.json()).toEqual({ state: 'collector_available' });
            expect(probe.headers['access-control-allow-origin']).toBe(config.webPostMessageTargetOrigin);
            expect(probe.body).not.toContain('button');
        } finally { await app.close(); }
    });

    it('carries the navigation reporter into every in-frame document of a bound relay preview and obeys only its own pane', async () => {
        const upstreamCookies: Array<string | undefined> = [];
        const fixture = await upstream((request, response) => {
            upstreamCookies.push(request.headers.cookie);
            if (request.url === '/asset.js') { response.setHeader('Content-Type', 'application/javascript'); response.end('window.asset=1'); return; }
            response.setHeader('Content-Type', 'text/html');
            response.end(`<html><head></head><body><a href="/other">${request.url}</a></body></html>`);
        });
        const config = { browserSessionId: 'bs', viewId: 'v', navigationGeneration: 1,
            collector: { collectorId: 'c', nonce: 'pane_nonce', version: '1.0.0' }, webPostMessageTargetOrigin: 'https://app.example.test' };
        const app = Fastify();
        app.decorate('authenticate', async () => {});
        registerLocalServicePreviewRoutes(app as never, { ...fixture, resolvePreview: () => fixture.preview,
            resolvePreviewByHost: (host) => host === 'preview.example.test' ? fixture.preview : null,
            hostOriginBaseDomain: 'example.test', validateAccess: ({ rawToken }) => rawToken === 'authorized' ? { ok: true } : { ok: false, reasonCode: 'token_invalid' } });
        const frame = { host: 'preview.example.test', 'sec-fetch-dest': 'iframe' };
        const authorized = 'happier_preview_token=authorized';
        const loaderOf = (html: string) => {
            const src = /<script defer src="([^"]+)"><\/script>/.exec(html)?.[1]?.replace(/&amp;/g, '&');
            return src ? new URL(src, 'http://preview.example.test') : null;
        };
        // The guest realm: the loader's bytes run against a window whose Navigation API is the browser boundary.
        const runLoader = (body: string, navigation: Record<string, unknown>) => {
            const messages: Array<Record<string, unknown>> = [];
            const parent = { postMessage: (data: string) => messages.push(JSON.parse(data)) };
            const called: string[] = [];
            const guest = Object.assign(new EventTarget(), { parent, navigation: Object.assign(new EventTarget(), navigation),
                location: { href: `http://preview.example.test/other?app=1&__happierCollector=${encodeURIComponent(JSON.stringify(config))}` },
                history: { back: () => called.push('back'), forward: () => called.push('forward') }, stop: () => called.push('stop'),
                localStorage: { length: 0 }, sessionStorage: { length: 0 } });
            runInNewContext(body, { window: guest, document: { title: 'Other', readyState: 'complete', documentElement: { nodeType: 1 }, querySelectorAll: () => [] },
                console: { log() {}, info() {}, warn() {}, error() {}, debug() {} }, performance: { getEntriesByType: () => [] }, Event, URL });
            const send = (origin: string, source: unknown, command: string, nonce = config.collector.nonce) => {
                const event = new Event('message');
                const data = JSON.stringify({ v: 1, kind: 'browser.collector.navigate', browserSessionId: 'bs', viewId: 'v', navigationGeneration: 1, collectorId: 'c', nonce, command });
                Object.defineProperties(event, { data: { value: data }, origin: { value: origin }, source: { value: source } });
                guest.dispatchEvent(event);
            };
            return { messages, called, send, parent, guest };
        };
        try {
            const entry = await app.inject({ method: 'GET', url: `/?__happierCollector=${encodeURIComponent(JSON.stringify(config))}`, headers: { ...frame, cookie: authorized } });
            const binding = [entry.headers['set-cookie']].flat().map(String).find((cookie) => cookie.startsWith('happier_preview_collector='));
            expect(binding).toBeDefined();
            expect(binding).toContain('HttpOnly');
            const bound = `${authorized}; ${binding!.split(';')[0]}`;

            // An in-frame link navigation carries no per-navigation query; the pane binding scopes it.
            const other = await app.inject({ method: 'GET', url: '/other?app=1', headers: { ...frame, cookie: bound } });
            const loaderUrl = loaderOf(other.body);
            expect(loaderUrl).not.toBeNull();
            expect(other.headers['x-happier-collector-state']).toBe('collector_available');
            expect(upstreamCookies.every((cookie) => !cookie?.includes('happier_preview_collector'))).toBe(true);

            const loader = await app.inject({ method: 'GET', url: loaderUrl!.pathname + loaderUrl!.search, headers: { host: frame.host, cookie: bound } });
            expect(loader.statusCode).toBe(200);
            const reporter = runLoader(loader.body, { canGoBack: true, canGoForward: false });
            expect(reporter.messages).toContainEqual({ v: 1, kind: 'browser.collector.navigation', browserSessionId: 'bs', viewId: 'v', navigationGeneration: 1,
                collectorId: 'c', nonce: 'pane_nonce', loading: false, canGoBack: true, canGoForward: false, url: 'http://preview.example.test/other?app=1' });
            // An in-frame document is not re-admitted to page automation: it only reports and obeys navigation.
            expect(reporter.messages.some((message) => message.kind === 'browser.collector.ready')).toBe(false);
            reporter.send('https://evil.example.test', reporter.parent, 'back');
            reporter.send(config.webPostMessageTargetOrigin, reporter.guest, 'back');
            reporter.send(config.webPostMessageTargetOrigin, reporter.parent, 'back', 'other_pane');
            expect(reporter.called).toEqual([]);
            reporter.send(config.webPostMessageTargetOrigin, reporter.parent, 'back');
            reporter.send(config.webPostMessageTargetOrigin, reporter.parent, 'forward');
            reporter.send(config.webPostMessageTargetOrigin, reporter.parent, 'stop');
            expect(reporter.called).toEqual(['back', 'forward', 'stop']);

            // The pane's first document reports through the same module, and a pending cross-document navigation is a loading state.
            const entryLoader = loaderOf(entry.body)!;
            const first = runLoader((await app.inject({ method: 'GET', url: entryLoader.pathname + entryLoader.search, headers: { host: frame.host, cookie: bound } })).body, { canGoBack: false, canGoForward: false });
            expect(first.messages).toContainEqual(expect.objectContaining({ kind: 'browser.collector.navigation', canGoBack: false, canGoForward: false, loading: false }));
            first.guest.navigation.dispatchEvent(Object.assign(new Event('navigate'), { destination: { sameDocument: false } }));
            expect(first.messages.at(-1)).toMatchObject({ kind: 'browser.collector.navigation', loading: true });

            // No binding, no injection; sub-resources and top-level navigations are never touched.
            expect(loaderOf((await app.inject({ method: 'GET', url: '/other', headers: { ...frame, cookie: authorized } })).body)).toBeNull();
            expect((await app.inject({ method: 'GET', url: '/asset.js', headers: { host: frame.host, 'sec-fetch-dest': 'script', cookie: bound } })).body).toBe('window.asset=1');
            expect(loaderOf((await app.inject({ method: 'GET', url: '/other', headers: { host: frame.host, 'sec-fetch-dest': 'document', cookie: bound } })).body)).toBeNull();
        } finally { await app.close(); }
    });

    it('keeps cooperative identity across same-preview redirects only and preserves application query bytes and non-HTML bytes', async () => {
        const seen: string[] = [];
        const fixture = await upstream((request, response) => {
            seen.push(request.url!);
            if (request.url?.startsWith('/redirect')) { response.writeHead(302, { location: '/asset?app=a%20b' }); response.end(); }
            else if (request.url?.startsWith('/external')) { response.writeHead(302, { location: 'https://external.example.test/' }); response.end(); }
            else if (request.url?.startsWith('/html-fetch')) { response.setHeader('content-type', 'text/html'); response.end('<html><head></head><body>Fetched</body></html>'); }
            else { response.setHeader('content-type', 'application/javascript'); response.end(Buffer.from([0, 255, 12])); }
        });
        const config = { browserSessionId: 'bs', viewId: 'v', navigationGeneration: 1, collector: { collectorId: 'c', nonce: 'n', version: '1.0.0' }, webPostMessageTargetOrigin: 'https://app.example.test' };
        const query = `__happierCollector=${encodeURIComponent(JSON.stringify(config))}`;
        const request = async (path: string, method = 'GET', probe = false, destination?: string) => {
            let headers: Readonly<Record<string, string | readonly string[]>> = {};
            const chunks: Uint8Array[] = [];
            let status = 0;
            const result = await proxyLocalServicePreviewHttpRequest({ ...fixture, request: { method, path, search: `?app=a%20b&${query}${probe ? '&__happierCollectorState=1' : ''}`, headers: { host: 'preview.example.test', ...(probe ? { origin: config.webPostMessageTargetOrigin } : {}), ...(destination ? { 'sec-fetch-dest': destination } : {}) } },
                response: { writeHead(code, _message, value) { status = code; headers = value; }, write(chunk) { chunks.push(chunk); }, end() {}, destroy() {} } });
            expect(result.ok).toBe(true);
            return { status, headers, body: Buffer.concat(chunks) };
        };
        const redirect = new URL(String((await request('/redirect')).headers.location), 'http://preview.example.test');
        expect(redirect.searchParams.get('__happierCollector')).toBe(JSON.stringify(config));
        expect((await request('/external')).headers.location).toBe('https://external.example.test/');
        expect((await request('/asset')).body).toEqual(Buffer.from([0, 255, 12]));
        expect((await request('/post', 'POST')).body).toEqual(Buffer.from([0, 255, 12]));
        expect(seen).toEqual(['/redirect?app=a%20b', '/external?app=a%20b', '/asset?app=a%20b', '/post?app=a%20b']);
        const probeRedirect = await request('/redirect', 'GET', true);
        expect(probeRedirect.status).toBe(302);
        expect(new URL(String(probeRedirect.headers.location), 'http://preview.example.test').searchParams.get('__happierCollectorState')).toBe('1');
        expect(probeRedirect.headers['access-control-allow-origin']).toBe(config.webPostMessageTargetOrigin);
        expect(probeRedirect.body.length).toBe(0);
        expect((await request('/html-fetch', 'GET', false, 'empty')).body.toString()).toBe('<html><head></head><body>Fetched</body></html>');
    });

    it('enforces the preview response budget on cooperative decompression, not just the compressed bytes', async () => {
        const { gzipSync } = await import('node:zlib');
        const fixture = await upstream((_request, response) => {
            response.setHeader('content-type', 'text/html'); response.setHeader('content-encoding', 'gzip');
            response.end(gzipSync(`<html><head></head><body>${'x'.repeat(4096)}</body></html>`));
        });
        fixture.preview.policy = { allowedMethods: ['GET'], cookiePolicy: 'rewrite', compressionPolicy: 'identity', redirectPolicy: 'preserve_host_origin', maxRequestBodyBytes: 1024, maxResponseBodyBytes: 1024 };
        const config = { browserSessionId: 'bs', viewId: 'v', navigationGeneration: 1, collector: { collectorId: 'c', nonce: 'n', version: '1.0.0' }, webPostMessageTargetOrigin: 'https://app.example.test' };
        let failure: unknown;
        let bytes = 0;
        const result = await proxyLocalServicePreviewHttpRequest({ ...fixture,
            request: { method: 'GET', path: '/', search: `?__happierCollector=${encodeURIComponent(JSON.stringify(config))}`, headers: { host: 'preview.example.test' } },
            response: { writeHead() {}, write(chunk) { bytes += chunk.length; }, end() {}, destroy(error) { failure = error; } } });
        expect(result).toEqual({ ok: false, reasonCode: 'response_body_too_large' });
        expect(failure).toBeInstanceOf(Error);
        expect(bytes).toBe(0);
    });

    it("preserves the IPv6 loopback authority for HTTP and same-preview Origin", async () => {
        let receivedHeaders: IncomingHttpHeaders = {};
        const fixture = await listenUpstream(createServer((request, response) => {
            receivedHeaders = request.headers;
            response.setHeader("Location", `http://${request.headers.host}/next`);
            response.end("ipv6");
        }), "http", "::1");
        fixture.preview.policy = {
            allowedMethods: ["GET"], cookiePolicy: "rewrite", compressionPolicy: "identity", redirectPolicy: "preserve_host_origin",
            maxRequestBodyBytes: 1024, maxResponseBodyBytes: 1024,
        };
        const result = await proxy(fixture, { host: "preview.example.test", origin: "https://preview.example.test" }, "https");
        expect(result.result).toEqual({ ok: true });
        expect(result.body.toString()).toBe("ipv6");
        expect(receivedHeaders.host).toBe(`[::1]:${fixture.preview.target.port}`);
        expect(receivedHeaders.origin).toBe(`http://[::1]:${fixture.preview.target.port}`);
        expect(result.headers.location).toBe("/next");
    });

    it("negotiates trusted TLS over the tunnel and rejects untrusted certificates", async () => {
        const scratch = await mkdtemp(join(tmpdir(), "happier-preview-tls-"));
        // The Node 24 test host has this native trust-store API; retained Node 22 typings do not.
        const trustStore = tls as unknown as { getCACertificates(): string[]; setDefaultCACertificates(certs: string[]): void };
        const originalTrust = trustStore.getCACertificates();
        try {
            const keyPath = join(scratch, "key.pem");
            const certPath = join(scratch, "cert.pem");
            await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath,
                "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1"]);
            const cert = await readFile(certPath, "utf8");
            const fixture = await listenUpstream(createHttpsServer({ key: await readFile(keyPath), cert }, (_request, response) => response.end("tls-body")), "https");
            trustStore.setDefaultCACertificates([...originalTrust, cert]);
            expect((await proxy(fixture)).body.toString()).toBe("tls-body");
            const wrongIdentity = await proxy({ ...fixture, preview: { ...fixture.preview,
                target: { ...fixture.preview.target, host: "127.0.0.2" } } });
            expect(wrongIdentity.result).toEqual({ ok: false, reasonCode: "upstream_stream_failed" });
            expect(wrongIdentity.failure).toBeInstanceOf(Error);
            trustStore.setDefaultCACertificates(originalTrust);
            const denied = await proxy(fixture);
            expect(denied.result).toEqual({ ok: false, reasonCode: "upstream_stream_failed" });
            expect(denied.failure).toBeInstanceOf(Error);
        } finally {
            trustStore.setDefaultCACertificates(originalTrust);
            await rm(scratch, { recursive: true, force: true });
        }
    });
    it("decodes chunked SSE framing and preserves binary range bytes", async () => {
        let completeSse: () => void = () => { throw new Error("SSE upstream has not received the request"); };
        const sse = await upstream((_request, response) => {
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.write("data: first\n\n");
            completeSse = () => response.end("data: second\n\n");
        });
        const events: Uint8Array[] = [];
        let firstForwarded = false;
        await proxyLocalServicePreviewHttpRequest({ ...sse,
            request: { method: "GET", path: "/", search: "", headers: {} },
            response: { writeHead() {}, write(chunk) {
                events.push(chunk);
                // The second event cannot exist until the first reaches the downstream sink.
                if (!firstForwarded && Buffer.concat(events).includes("data: first\n\n")) {
                    firstForwarded = true;
                    completeSse();
                }
            }, end() {}, destroy(error) { throw error; } },
        });
        expect(Buffer.concat(events).toString()).toBe("data: first\n\ndata: second\n\n");
        const range = await upstream((_request, response) => {
            response.writeHead(206, { "content-range": "bytes 1-3/5", "content-length": "3" });
            response.end(Buffer.from([0, 255, 128]));
        });
        const result = await proxy(range, { range: "bytes=1-3" });
        expect(result.status).toBe(206);
        expect(result.body).toEqual(Buffer.from([0, 255, 128]));
    });

    it("streams unknown-length request bodies using native chunk framing", async () => {
        const fixture = await upstream(echoRequest);
        const bytes: Uint8Array[] = [];
        const result = await proxyLocalServicePreviewHttpRequest({ ...fixture,
            request: { method: "PUT", path: "/", search: "", headers: { "content-type": "application/octet-stream" },
                body: (async function* () { yield Buffer.from([0, 255]); yield Buffer.from([13, 10]); })() },
            response: { writeHead() {}, write(chunk) { bytes.push(chunk); }, end() {}, destroy(error) { throw error; } },
        });
        expect(result).toEqual({ ok: true });
        expect(Buffer.concat(bytes)).toEqual(Buffer.from([0, 255, 13, 10]));
    });

    it("round-trips app cookies and maps same-preview origin metadata while stripping authority and spoofed forwarding", async () => {
        let received: IncomingHttpHeaders = {};
        const fixture = await upstream((request, response) => {
            received = request.headers;
            response.end("ok");
        });
        fixture.preview.policy = {
            allowedMethods: ["GET"], cookiePolicy: "rewrite", compressionPolicy: "identity", redirectPolicy: "preserve_host_origin",
            maxRequestBodyBytes: 1024, maxResponseBodyBytes: 1024,
        };
        await proxy(fixture, { host: "app.preview.test", origin: "https://app.preview.test", referer: "https://app.preview.test/page?q=1",
            cookie: "happier_preview_token=secret; happier_public_token=secret2; sid=app", "x-forwarded-proto": "spoof", forwarded: "spoof" }, "https");
        expect(received.cookie).toBe("sid=app");
        expect(received.origin).toBe(`http://127.0.0.1:${fixture.preview.target.port}`);
        expect(received.referer).toBe(`http://127.0.0.1:${fixture.preview.target.port}/page?q=1`);
        expect(received["x-forwarded-proto"]).toBe("https");
        expect(received.forwarded).toBeUndefined();
    });

    it("routes raw multipart and whitespace-preserving JSON without changing control API parsing", async () => {
        const fixture = await upstream(echoRequest);
        const app = Fastify();
        app.decorate("authenticate", async () => {});
        app.post("/control", async (request) => ({ parsed: request.body }));
        registerLocalServicePreviewRoutes(app as never, { ...fixture, resolvePreview: () => fixture.preview,
            resolvePreviewByHost: (host) => host === "app.preview.test" ? fixture.preview : null,
            hostOriginBaseDomain: "preview.test", validateAccess: () => ({ ok: true }) });
        try {
            for (const [contentType, payload] of [
                ["application/json", '{  "a" : 1  }'],
                ["multipart/form-data; boundary=fixture", "--fixture\r\nContent-Disposition: form-data; name=\"file\"\r\n\r\nraw\r\n--fixture--\r\n"],
            ]) {
                const response = await app.inject({ method: "PATCH", url: "/", headers: { host: "app.preview.test", "content-type": contentType }, payload });
                expect(response.statusCode).toBe(200);
                expect(response.body).toBe(payload);
            }
            const control = await app.inject({ method: "POST", url: "/control", headers: { "content-type": "application/json" }, payload: '{ "a": 1 }' });
            expect(control.json()).toEqual({ parsed: { a: 1 } });
        } finally { await app.close(); }
    });

    it("preserves public application JSON and multipart bytes without changing control JSON parsing", async () => {
        // Reply on the first small payload chunk: a corrupted JSON upload retains the original
        // Content-Length, so waiting for request EOF would conceal the byte mismatch as a timeout.
        let forwardedProtocol: string | string[] | undefined;
        const fixture = await upstream((request, response) => {
            forwardedProtocol = request.headers["x-forwarded-proto"];
            request.once("data", (chunk) => response.end(chunk));
        });
        const app = Fastify({ trustProxy: true });
        app.decorate("authenticate", async () => {});
        app.post("/control", async (request) => ({ parsed: request.body }));
        registerLocalServicePublicRoutes(app as never, {
            ...fixture, resolvePreview: () => fixture.preview,
            createExposure: () => ({ ok: false, reasonCode: "public_origin_unavailable" }),
            revokeExposure: () => ({ ok: true }),
            validateAccess: () => ({ ok: true, preview: fixture.preview }),
        });
        try {
            for (const [contentType, payload] of [
                ["application/json", '{  "a" : 1  }'],
                ["multipart/form-data; boundary=fixture", "--fixture\r\nContent-Disposition: form-data; name=\"file\"\r\n\r\nraw\r\n--fixture--\r\n"],
            ]) {
                const response = await app.inject({ method: "PATCH", url: "/v1/local-services/public/exposure/upload", headers: { "content-type": contentType, "x-forwarded-proto": "https" }, payload });
                expect(response.statusCode).toBe(200);
                expect(response.body).toBe(payload);
                expect(forwardedProtocol).toBe("https");
            }
            const control = await app.inject({ method: "POST", url: "/control", headers: { "content-type": "application/json" }, payload: '{ "a": 1 }' });
            expect(control.json()).toEqual({ parsed: { a: 1 } });
        } finally { await app.close(); }
    });

    it("reconnects origin-checking HMR upgrades with application cookies and preserved subprotocol", async () => {
        const fixture = await upstream((_request, response) => response.end());
        const server = servers.at(-1)!;
        fixture.preview.policy = {
            allowedMethods: ["GET"], cookiePolicy: "rewrite", compressionPolicy: "identity", redirectPolicy: "preserve_host_origin",
            maxRequestBodyBytes: 1024, maxResponseBodyBytes: 1024,
        };
        server.on("upgrade", (request, socket) => {
            if (request.headers.origin !== `http://127.0.0.1:${fixture.preview.target.port}` || request.headers.cookie !== "sid=app") {
                socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
                return;
            }
            const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
            socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: vite-hmr\r\n\r\n`);
            socket.on("data", () => socket.end(Buffer.from([0x81, 2, 0x6f, 0x6b])));
        });
        for (let reconnect = 0; reconnect < 2; reconnect += 1) {
            const output: Uint8Array[] = [];
            const headers = {
                host: "app.preview.test", origin: "https://app.preview.test", cookie: "happier_preview_token=secret; sid=app",
                connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13", "sec-websocket-protocol": "vite-hmr",
            };
            const result = await proxyLocalServicePreviewWebSocketUpgrade({ ...fixture, request: {
                path: "/hmr", search: "", headers, rawHeaders: Object.entries(headers).flat(),
                client: {
                    read: async function* () { yield Buffer.from([0x81, 0x80, 0, 0, 0, 0]); },
                    write(chunk) { output.push(chunk); }, end() {}, destroy() {},
                },
            } });
            expect(result).toEqual({ ok: true });
            const received = Buffer.concat(output);
            expect(received.toString()).toContain("101 Switching Protocols");
            expect(received.toString().toLowerCase()).toContain("sec-websocket-protocol: vite-hmr");
            expect(received.subarray(-4)).toEqual(Buffer.from([0x81, 2, 0x6f, 0x6b]));
        }
    });
});
