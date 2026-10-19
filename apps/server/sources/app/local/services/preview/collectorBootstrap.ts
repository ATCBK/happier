import { Readable } from 'node:stream';
import { STATUS_CODES } from 'node:http';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { INJECTED_CONSOLE_TEXT_MAX_LENGTH, INJECTED_OWNER_VALUE_MAX_LENGTH } from '@happier-dev/protocol/browser/diagnostics/egress/classifier';
import { SAFE_TELEMETRY_HEADER_NAMES } from '@happier-dev/protocol/browser/diagnostics/egress/headers';
import { buildCooperativeNavigationRuntimeScript, buildInjectedBrowserDiagnosticsRuntimeScript } from '@happier-dev/peer-mediation/browser/collector/build';
import {
    COOPERATIVE_COLLECTOR_QUERY, COOPERATIVE_COLLECTOR_STATE_QUERY, COOPERATIVE_COLLECTOR_LOADER_PATH,
    COOPERATIVE_COLLECTOR_NAVIGATION_QUERY, COOPERATIVE_COLLECTOR_BINDING_COOKIE,
    type CooperativeCollectorConfig, parseCooperativeCollectorConfig, stripCooperativeCollectorQuery, buildCooperativeCollectorNavigationUrl,
} from '@happier-dev/peer-mediation/browser/collector/cooperative';
import type { LocalServicePreviewHttpResponseHeaders } from '@happier-dev/peer-mediation/localServices/preview/httpAdapter';
import type { ProxyLocalServicePreviewHttpRequestInput } from './httpAdapter';
import { scopedLocalServiceViewerTokenCookie } from '../viewerCookie';

function header(headers: LocalServicePreviewHttpResponseHeaders, name: string): string {
    const value = headers[name];
    return Array.isArray(value) ? value.join(',') : typeof value === 'string' ? value : '';
}

// This is an admission check, not a CSP replacement. The browser still enforces every
// original policy. Unsupported script sources fail closed rather than borrowing page nonces.
function permitsLoader(policy: string, loader: URL): boolean {
    return policy.split(',').every((part) => {
        const directives = new Map<string, string[]>();
        for (const directive of part.split(';')) {
            const [name, ...sources] = directive.trim().split(/\s+/);
            if (!directives.has(name.toLowerCase())) directives.set(name.toLowerCase(), sources);
        }
        const sandbox = directives.get('sandbox');
        if (sandbox && (!sandbox.includes('allow-scripts') || !sandbox.includes('allow-same-origin'))) return false;
        const sources = directives.get('script-src-elem') ?? directives.get('script-src') ?? directives.get('default-src');
        if (!sources) return true;
        if (sources.includes("'strict-dynamic'")) return false;
        return sources.some((source) => {
            if (source === "'self'" || source === '*' || source === loader.protocol) return true;
            if (source.startsWith("'")) return false;
            try {
                const allowed = new URL(source.includes('://') ? source : `${loader.protocol}//${source}`);
                return allowed.origin === loader.origin && (allowed.pathname === '/' || allowed.pathname === loader.pathname
                    || (allowed.pathname.endsWith('/') && loader.pathname.startsWith(allowed.pathname)));
            } catch { return false; }
        });
    });
}

function htmlAdmission(html: string, policy: string, loader: URL): { allowed: boolean; offset: number } {
    const tree = parse(html, { sourceCodeLocationInfo: true });
    const element = tree.childNodes.find((node) => 'tagName' in node && node.tagName === 'html');
    const head = element && 'childNodes' in element ? element.childNodes.find((node) => 'tagName' in node && node.tagName === 'head') : undefined;
    let allowed = permitsLoader(policy, loader);
    const visit = (node: DefaultTreeAdapterMap['node']) => {
        if ('tagName' in node && node.tagName === 'meta') {
            const equiv = node.attrs.find((attr) => attr.name === 'http-equiv')?.value.toLowerCase();
            if (equiv === 'content-security-policy') allowed &&= permitsLoader(node.attrs.find((attr) => attr.name === 'content')?.value ?? '', loader);
        }
        // Template contents are inert; parse5 keeps them outside childNodes.
        if ('childNodes' in node) node.childNodes.forEach(visit);
    };
    if (head) visit(head);
    const location = head && 'tagName' in head ? head.sourceCodeLocation : undefined;
    const rootLocation = element && 'tagName' in element ? element.sourceCodeLocation : undefined;
    return { allowed, offset: location?.endTag?.startOffset ?? location?.startTag?.endOffset ?? rootLocation?.startTag?.endOffset ?? 0 };
}

async function decodeBody(chunks: Uint8Array[], encoding: string, maxBytes: number | undefined): Promise<Buffer> {
    const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : null;
    if (!decoder) return Buffer.concat(chunks);
    const bytes: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of Readable.from(chunks).pipe(decoder)) {
        size += chunk.length;
        if (maxBytes !== undefined && size > maxBytes) {
            decoder.destroy();
            throw new Error('response_body_too_large');
        }
        bytes.push(chunk);
    }
    return Buffer.concat(bytes);
}

/**
 * An in-frame document request carries no per-navigation query. The pane's binding cookie, set by the
 * document that did, names the pane it belongs to; only an iframe document request is eligible.
 */
function readBoundCollectorConfig(input: ProxyLocalServicePreviewHttpRequestInput): CooperativeCollectorConfig | null {
    if (input.request.method !== 'GET' || input.preview.originMode !== 'host' || input.request.headers['sec-fetch-dest'] !== 'iframe') return null;
    const cookies = input.request.headers.cookie;
    for (const entry of (typeof cookies === 'string' ? cookies : (cookies ?? []).join(';')).split(';')) {
        const [name, ...value] = entry.trim().split('=');
        if (name !== COOPERATIVE_COLLECTOR_BINDING_COOKIE) continue;
        try { return parseCooperativeCollectorConfig(decodeURIComponent(value.join('='))); } catch { return null; }
    }
    return null;
}

/** Called only after the existing preview route has admitted access; configuration is not a grant. */
export async function prepareCooperativePreview(input: ProxyLocalServicePreviewHttpRequestInput): Promise<ProxyLocalServicePreviewHttpRequestInput | null> {
    const query = new URLSearchParams(input.request.search);
    const probe = query.get(COOPERATIVE_COLLECTOR_STATE_QUERY) === '1';
    const hasCollectorConfig = query.has(COOPERATIVE_COLLECTOR_QUERY);
    const boundConfig = hasCollectorConfig || probe ? null : readBoundCollectorConfig(input);
    if (!hasCollectorConfig && !probe && !boundConfig) return input;
    const config = boundConfig ?? parseCooperativeCollectorConfig(query.get(COOPERATIVE_COLLECTOR_QUERY));
    const respond = async (status: number, body: string, headers: LocalServicePreviewHttpResponseHeaders) => {
        input.response.writeHead(status, STATUS_CODES[status] ?? '', { 'cache-control': 'no-store', ...headers });
        await input.response.write(Buffer.from(body));
        await input.response.end();
    };
    if (hasCollectorConfig && (!config || input.preview.originMode !== 'host')) {
        await respond(400, JSON.stringify({ state: 'runtime_unavailable' }), { 'content-type': 'application/json' });
        return null;
    }
    if (config && input.request.path === COOPERATIVE_COLLECTOR_LOADER_PATH) {
        if (input.request.method !== 'GET' || query.get('n') !== config.collector.nonce) {
            await respond(400, JSON.stringify({ state: 'collector_mismatch' }), { 'content-type': 'application/json' });
            return null;
        }
        const runtimeConfig = JSON.stringify({
            ...config, cooperativePreview: true,
            ...(config.ownerConsoleValueCapture ? { consoleTextMaxLength: INJECTED_CONSOLE_TEXT_MAX_LENGTH } : {}),
            ...(config.ownerDiagnosticsValueCapture ? { ownerValueMaxLength: INJECTED_OWNER_VALUE_MAX_LENGTH, safeTelemetryHeaderNames: [...SAFE_TELEMETRY_HEADER_NAMES] } : {}),
        }).replace(/</g, '\\u003c');
        const script = query.get(COOPERATIVE_COLLECTOR_NAVIGATION_QUERY) === '1'
            ? buildCooperativeNavigationRuntimeScript(runtimeConfig)
            : buildInjectedBrowserDiagnosticsRuntimeScript(runtimeConfig);
        await respond(200, script, { 'content-type': 'application/javascript; charset=utf-8', 'x-content-type-options': 'nosniff' });
        return null;
    }
    const requestOrigin = input.request.headers.origin;
    const parentOrigin = config?.webPostMessageTargetOrigin ?? (typeof requestOrigin === 'string' ? requestOrigin : undefined);
    if (probe && (requestOrigin !== parentOrigin || (parentOrigin !== undefined
        && (!/^https?:\/\//.test(parentOrigin) || URL.canParse(parentOrigin) === false || new URL(parentOrigin).origin !== parentOrigin)))) {
        await respond(403, JSON.stringify({ state: 'runtime_unavailable' }), { 'content-type': 'application/json' });
        return null;
    }
    const upstreamSearch = stripCooperativeCollectorQuery(input.request.search);
    const destination = input.request.headers['sec-fetch-dest'];
    if (input.request.method !== 'GET' || (!probe && typeof destination === 'string'
        && destination !== 'iframe' && destination !== 'document')) {
        return { ...input, request: { ...input.request, search: upstreamSearch } };
    }
    const host = input.request.headers.host;
    if (typeof host !== 'string') {
        await respond(400, JSON.stringify({ state: 'runtime_unavailable' }), { 'content-type': 'application/json' });
        return null;
    }
    const origin = new URL(`${input.request.externalProtocol ?? 'http'}://${host}`).origin;
    const loader = new URL(COOPERATIVE_COLLECTOR_LOADER_PATH, origin);
    if (config) {
        loader.searchParams.set('n', config.collector.nonce);
        loader.searchParams.set(COOPERATIVE_COLLECTOR_QUERY, JSON.stringify(config));
        // An in-frame document reports and obeys navigation only; the pane's own document keeps the full collector.
        if (boundConfig) loader.searchParams.set(COOPERATIVE_COLLECTOR_NAVIGATION_QUERY, '1');
    }
    let status = 0;
    let message = '';
    let headers: LocalServicePreviewHttpResponseHeaders = {};
    let collectHtml = false;
    let transportUnavailable = false;
    let probeRedirect: string | undefined;
    const chunks: Uint8Array[] = [];
    return { ...input, request: { ...input.request, search: upstreamSearch },
        onTransportUnavailable(event) {
            transportUnavailable = true;
            input.onTransportUnavailable?.(event);
        }, response: {
        writeHead(code, statusMessage, value) {
            status = code; message = statusMessage; headers = value;
            collectHtml = config !== null && code === 200 && /^text\/html(?:;|$)/i.test(header(value, 'content-type'));
            if (!collectHtml) {
                const location = header(value, 'location');
                if (code >= 300 && code < 400 && location) {
                    try {
                        const next = new URL(location, `${origin}${input.request.path}`);
                        if (next.origin === origin) {
                            // Redirects within the admitted preview retain this navigation's identity;
                            // an external destination must never receive it.
                            const admitted = new URL(config && !boundConfig ? buildCooperativeCollectorNavigationUrl(next.href, config) : next.href);
                            if (probe) {
                                admitted.search += `${admitted.search ? '&' : '?'}${COOPERATIVE_COLLECTOR_STATE_QUERY}=1`;
                                probeRedirect = admitted.pathname + admitted.search + admitted.hash;
                            }
                            headers = { ...value, location: admitted.pathname + admitted.search + admitted.hash };
                        }
                    } catch { /* Leave invalid application redirects to the browser. */ }
                }
                if (!probe) input.response.writeHead(code, statusMessage, headers);
            }
        },
        async write(chunk) {
            if (collectHtml || (probe && transportUnavailable)) chunks.push(chunk);
            else if (!probe) await input.response.write(chunk);
        },
        async end() {
            let state = 'runtime_unavailable';
            let output: Buffer | undefined;
            if (collectHtml) {
                const encoding = header(headers, 'content-encoding').trim().toLowerCase();
                const charset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(header(headers, 'content-type'))?.[1] ?? 'utf-8';
                if (['', 'identity', 'gzip', 'deflate', 'br'].includes(encoding)) {
                    const body = await decodeBody(chunks, encoding, input.preview.policy?.maxResponseBodyBytes);
                    let html: string | undefined;
                    try { html = new TextDecoder(charset, { fatal: true }).decode(body); } catch { /* Preserve unsupported encodings without injection. */ }
                    if (html !== undefined) {
                        const admission = htmlAdmission(html, header(headers, 'content-security-policy'), loader);
                        state = admission.allowed ? 'collector_available' : 'collector_blocked_by_csp';
                        if (admission.allowed) {
                            const tag = `<script defer src="${loader.href.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></script>`;
                            output = Buffer.from(html.slice(0, admission.offset) + tag + html.slice(admission.offset));
                        }
                    }
                }
            }
            if (probe) {
                // Preserve the proxy's typed refusal, not an application's error body. The existing
                // transport callback is authoritative; status or JSON supplied by the app is not.
                await respond(transportUnavailable || probeRedirect ? status : 200,
                    transportUnavailable ? Buffer.concat(chunks).toString('utf8') : probeRedirect ? '' : JSON.stringify({ state }), { 'content-type': 'application/json',
                    ...(probeRedirect ? { location: probeRedirect } : {}),
                    ...(parentOrigin ? { 'access-control-allow-origin': parentOrigin, 'access-control-allow-credentials': 'true' } : {}), 'vary': 'Origin' });
                return;
            }
            if (collectHtml) {
                const nextHeaders: Record<string, string | readonly string[]> = { ...headers, 'x-happier-collector-state': state };
                if (output) {
                    for (const name of ['content-encoding', 'content-length', 'etag', 'content-md5', 'digest']) delete nextHeaders[name];
                    nextHeaders['content-type'] = 'text/html; charset=utf-8';
                    nextHeaders['cache-control'] = 'no-store';
                    // The pane's own document binds later in-frame documents to this identity.
                    if (config && hasCollectorConfig) {
                        const binding = scopedLocalServiceViewerTokenCookie({ name: COOPERATIVE_COLLECTOR_BINDING_COOKIE, path: '/', value: JSON.stringify(config) });
                        const existing = nextHeaders['set-cookie'];
                        nextHeaders['set-cookie'] = [...(Array.isArray(existing) ? existing : existing ? [existing] : []), binding];
                    }
                }
                input.response.writeHead(status, message, nextHeaders);
                await input.response.write(output ?? Buffer.concat(chunks));
            }
            await input.response.end();
        },
        destroy: (error) => input.response.destroy(error),
    } };
}
