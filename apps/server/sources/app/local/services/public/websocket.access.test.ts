import { EventEmitter } from 'node:events';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import type { LocalServicePreviewResourceV1 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';
import { createLocalServicePublicRuntime } from './runtime';
import { createLocalServicePublicRateLimitChecker } from './rateLimits';
import { handleLocalServicePublicWebSocketUpgrade } from './websocket';
import { resolveApiTrustProxy } from '@/app/api/utils/apiRateLimitPolicy';
import type { OpenLocalServicePreviewTunnel } from '../preview/httpAdapter';

const preview: LocalServicePreviewResourceV1 = {
    previewId: 'preview', sessionId: 'session', machineId: 'machine', owner: { kind: 'session', id: 'session' },
    target: { scheme: 'http', host: '127.0.0.1', port: 5173 }, initialPath: { pathname: '/', search: '' },
    display: { title: 'App', addressLabel: 'localhost:5173' }, originMode: 'host',
};

function createRuntime() {
    const runtime = createLocalServicePublicRuntime({
        publicBaseUrl: 'https://home.example.test', hostOriginBaseDomain: 'preview.example.test',
        policy: { enabled: true, allowedModes: ['public'], maxTtlMs: 60_000, auditRequired: false, rateLimitProfileIds: ['default'] },
        nowMs: () => 1_000, generateExposureId: () => 'share', resolvePreview: () => preview,
        checkRateLimit: createLocalServicePublicRateLimitChecker({ kind: 'fixed_window', maxRequests: 1, windowMs: 60_000 }),
    });
    expect(runtime.createExposure({ preview, requestedMode: 'public', requestedTtlMs: 60_000, actorId: 'owner', sessionAuthorized: true, dnsTlsValid: true, rateLimitProfileId: 'default' }).ok).toBe(true);
    return runtime;
}

// OS socket and network tunnel boundaries only; real authorization, limiter and WS adapter.
function socketBoundary(hold = false) {
    const events = new EventEmitter();
    let release = () => {};
    let upgraded = () => {};
    const closed = new Promise<void>((resolve) => { release = resolve; });
    const handshake = new Promise<void>((resolve) => { upgraded = resolve; });
    const output: string[] = [];
    const upstreamWrites: string[] = [];
    const socket = Object.assign(events, {
        remoteAddress: '127.0.0.1', destroyed: false,
        write(chunk: Uint8Array) { const text = new TextDecoder().decode(chunk); output.push(text); if (text.includes('101 Switching Protocols')) upgraded(); return true; },
        end() { release(); },
        destroy() { socket.destroyed = true; release(); events.emit('close'); },
        async *[Symbol.asyncIterator]() { if (hold) await closed; },
    });
    const openTunnel: OpenLocalServicePreviewTunnel = async () => ({
        tunnelId: 'tunnel', substreamId: 'stream', write(chunk) { upstreamWrites.push(new TextDecoder().decode(chunk)); }, endWrite() {}, close() { release(); }, abort() { release(); },
        async *read() {
            yield new TextEncoder().encode('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n');
            if (hold) await closed;
        },
    });
    return { socket, output, openTunnel, handshake, upstreamWrites };
}

function upgradeRequest(ip: string) {
    const headers = { host: 'share.preview.example.test', upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13', 'x-forwarded-for': ip };
    // Node owns headers through a prototype accessor; a plain object hides lost-header projections.
    const request = new IncomingMessage(new Socket());
    request.url = '/v1/local-services/public/share/socket';
    request.rawHeaders = Object.entries(headers).flat();
    request.headers = headers;
    return request;
}

describe('public WS access lifecycle', () => {
    it.each(['http', 'https'] as const)('projects the admitted %s upgrade protocol without trusting spoofed forwarding headers', async (externalProtocol) => {
        const runtime = createRuntime();
        const boundary = socketBoundary();
        const request = upgradeRequest('203.0.113.1');
        await handleLocalServicePublicWebSocketUpgrade({ ...request,
            headers: { ...request.headers, 'x-forwarded-proto': 'spoof' },
        }, boundary.socket, new Uint8Array(), {
            validateAccess: runtime.validateAccess, resolveExposure: runtime.resolveExposure,
            openTunnel: boundary.openTunnel, externalProtocol,
        });
        expect(boundary.output.join('')).toContain('101 Switching Protocols');
        expect(boundary.upstreamWrites.join('')).toContain(`X-Forwarded-Proto: ${externalProtocol}\r\n`);
        expect(boundary.upstreamWrites.join('')).not.toContain('spoof');
    });

    it('uses the HTTP trustProxy client identity for separate viewers behind one proxy', async () => {
        const runtime = createRuntime();
        for (const ip of ['203.0.113.1', '203.0.113.2']) {
            const boundary = socketBoundary();
            await handleLocalServicePublicWebSocketUpgrade(upgradeRequest(ip), boundary.socket, new Uint8Array(), {
                validateAccess: runtime.validateAccess, resolveExposure: runtime.resolveExposure, trustProxy: resolveApiTrustProxy({ HAPPIER_SERVER_TRUST_PROXY: '127.0.0.1' }), openTunnel: boundary.openTunnel,
            });
            expect(boundary.output.join('')).toContain('101 Switching Protocols');
        }
    });

    it('keeps forged forwarded IPs from splitting one untrusted upgrade peer into separate rate-limit buckets', async () => {
        const runtime = createRuntime();
        for (const [index, ip] of ['203.0.113.1', '203.0.113.2'].entries()) {
            const boundary = socketBoundary();
            boundary.socket.remoteAddress = '127.0.0.2';
            await handleLocalServicePublicWebSocketUpgrade(upgradeRequest(ip), boundary.socket, new Uint8Array(), {
                validateAccess: runtime.validateAccess, resolveExposure: runtime.resolveExposure,
                trustProxy: resolveApiTrustProxy({ HAPPIER_SERVER_TRUST_PROXY: '127.0.0.1' }), openTunnel: boundary.openTunnel,
            });
            expect(boundary.output.join('')).toContain(index === 0 ? '101 Switching Protocols' : '403 Forbidden');
        }
    });

    it('closes an existing websocket and refuses a new viewer when its share is revoked', async () => {
        const runtime = createRuntime();
        const boundary = socketBoundary(true);
        const pending = handleLocalServicePublicWebSocketUpgrade(upgradeRequest('203.0.113.1'), boundary.socket, new Uint8Array(), {
            validateAccess: runtime.validateAccess, resolveExposure: runtime.resolveExposure, openTunnel: boundary.openTunnel,
            retainConnection: runtime.retainConnection,
        });
        await boundary.handshake;
        expect(boundary.socket.destroyed).toBe(false);
        expect(runtime.revokeExposure('share', { actorId: 'owner' })).toEqual({ ok: true });
        expect(boundary.socket.destroyed).toBe(true);
        await pending;
        const next = socketBoundary();
        await handleLocalServicePublicWebSocketUpgrade(upgradeRequest('203.0.113.2'), next.socket, new Uint8Array(), {
            validateAccess: runtime.validateAccess, resolveExposure: runtime.resolveExposure, openTunnel: next.openTunnel,
        });
        expect(next.output.join('')).toContain('403 Forbidden');
    });
});
