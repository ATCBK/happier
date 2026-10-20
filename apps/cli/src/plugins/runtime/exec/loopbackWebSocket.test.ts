import { createServer, type AddressInfo, type Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { constants } from 'node:os';

import { describe, expect, it, vi } from 'vitest';

import type {
    ExecLoopbackWebSocketEndpointV1,
    ExecLoopbackWebSocketJsonClientSpecV1,
    ExecProcessHandleV1,
} from './privateContract';

import { encodeLoopbackHandshakeFrame, readLoopbackHandshakeFrame } from './loopbackHandshake';
import {
    createLoopbackWebSocketJsonClient,
    createLoopbackWebSocketProcessClient,
} from './loopbackWebSocket';

async function createRawLoopbackProbe(): Promise<{
    readonly port: number;
    readonly received: () => Buffer;
    readonly close: () => Promise<void>;
}> {
    const chunks: Buffer[] = [];
    const server = createServer((socket) => {
        socket.on('data', (chunk) => {
            chunks.push(Buffer.from(chunk));
            socket.destroy();
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
    const address = server.address() as AddressInfo;
    return {
        port: address.port,
        received: () => Buffer.concat(chunks),
        close: async () => {
            await new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            });
        },
    };
}

async function createHangingUpgradeServer(): Promise<{
    readonly port: number;
    readonly requested: Promise<void>;
    readonly completeUpgrade: () => void;
    readonly sendJsonBurst: (count: number, payloadBytes?: number) => void;
    readonly ponged: Promise<void>;
    readonly close: () => Promise<void>;
}> {
    const sockets = new Set<Socket>();
    let markRequested!: () => void;
    const requested = new Promise<void>(resolve => { markRequested = resolve; });
    let completeUpgrade = () => undefined;
    let sendJsonBurst = (_count: number, _payloadBytes = 0) => undefined;
    let markPonged!: () => void;
    const ponged = new Promise<void>(resolve => { markPonged = resolve; });
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => {
            sockets.delete(socket);
        });
        let request = '';
        let upgraded = false;
        socket.on('data', chunk => {
            if (upgraded) {
                const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                if ((bytes[0]! & 0x0f) === 0xa) markPonged();
                return;
            }
            // Accept the TCP connection and request bytes but never complete the
            // WebSocket upgrade until the test requests it.
            request += chunk.toString('latin1');
            if (!request.includes('\r\n\r\n')) return;
            const key = /Sec-WebSocket-Key: ([^\r\n]+)/i.exec(request)?.[1];
            if (!key) return;
            completeUpgrade = () => {
                const acceptKey = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
                socket.write([
                    'HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
                    `Sec-WebSocket-Accept: ${acceptKey}`, '', '',
                ].join('\r\n'));
                upgraded = true;
            };
            sendJsonBurst = (count, payloadBytes = 0) => {
                const frames = Array.from({ length: count }, (_, index) => {
                    const text = Buffer.from(JSON.stringify(payloadBytes === 0 ? index : { index, payload: 'x'.repeat(payloadBytes) }));
                    const header = Buffer.alloc(text.byteLength < 126 ? 2 : 4);
                    header[0] = 0x81;
                    if (header.byteLength === 2) header[1] = text.byteLength;
                    else {
                        header[1] = 126;
                        header.writeUInt16BE(text.byteLength, 2);
                    }
                    return Buffer.concat([header, text]);
                });
                socket.write(Buffer.concat([...frames, Buffer.from([0x89, 0])]));
            };
            markRequested();
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
    const address = server.address() as AddressInfo;
    return {
        port: address.port,
        requested,
        completeUpgrade: () => completeUpgrade(),
        sendJsonBurst: (count, payloadBytes) => sendJsonBurst(count, payloadBytes),
        ponged,
        close: async () => {
            for (const socket of sockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            });
        },
    };
}

function decodeHandshake(bytes: Uint8Array): {
    host?: string;
    port?: number;
    path?: string;
    protocol?: string;
    apiKey?: string;
    url?: string;
} {
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
}

function createSpec(
    executablePath: string,
    config: Record<string, unknown>,
): ExecLoopbackWebSocketJsonClientSpecV1<ExecLoopbackWebSocketEndpointV1> {
    const apiKey = typeof config.apiKey === 'string' ? config.apiKey : 'fixture-loopback-key';
    const byteOrder = config.byteOrder === 'big-endian' ? 'big-endian' : 'little-endian';
    return {
        launch: {
            kind: 'binary',
            executablePath: process.execPath,
            args: [executablePath],
            env: {
                HAPPIER_LOOPBACK_WS_FIXTURE_CONFIG: JSON.stringify({ ...config, apiKey }),
            },
        },
        transport: {
            kind: 'spawned-loopback-websocket',
            handshake: {
                byteOrder,
                requestFrames: [Uint8Array.from([0x61, 0x62, 0x63])],
                response: {
                    byteOrder,
                    maxFrameBytes: 4096,
                    // The fixture spawns a fresh Node process; leave startup
                    // scheduling headroom while dedicated timeout cases retain
                    // their explicit short deadlines below.
                    timeoutMs: 1_500,
                },
            },
            connect: {
                timeoutMs: 600,
                retryInitialDelayMs: 5,
                retryMaxDelayMs: 25,
            },
            shutdown: {
                kind: 'close-stdin',
                graceMs: 300,
            },
            limits: {
                maxMessageBytes: 2048,
                maxPendingMessages: 8,
                maxBufferedBytes: 4096,
            },
        },
        protocol: {
            kind: 'json-websocket',
            endpoint: {
                decodeHandshakeResponse: decodeHandshake,
                buildHeaders(endpoint) {
                    const endpointApiKey = typeof endpoint.apiKey === 'string' ? endpoint.apiKey : apiKey;
                    return [
                        {
                            name: 'x-loopback-api-key',
                            value: endpointApiKey,
                            sensitive: true,
                        },
                    ];
                },
            },
        },
        lifecycle: {
            maxStderrBytes: 256,
            diagnostics: {
                sanitizer: {
                    redactedValues: [apiKey, String(config.secret ?? '')].filter((value) => value.length > 0),
                },
            },
        },
    };
}

function createAlreadyFlowingHandshakeProcess(
    responseFrame: Buffer,
): {
    readonly process: Parameters<typeof createLoopbackWebSocketProcessClient>[0]['process'];
    readonly wroteStdin: () => boolean;
} {
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    let stdinWritten = false;

    stdout.on('data', () => {
        // Simulates the generic bounded stdout diagnostics capture already flowing.
    });

    const exit = new Promise<Awaited<ExecProcessHandleV1['exit']>>(() => {
        // Keep the synthetic child alive long enough for the handshake timeout path.
    });
    const handle: ExecProcessHandleV1 = {
        pid: 12_345,
        exit,
        writeStdin: async () => {
            stdinWritten = true;
            stdout.write(responseFrame);
        },
        kill: () => false,
        dispose: async () => undefined,
    };

    return {
        process: {
            child: {
                stdin,
                stdout,
            },
            handle,
            readStderrPreview: () => 'synthetic stderr preview with token <redacted>',
        },
        wroteStdin: () => stdinWritten,
    };
}

describe('A.13p.10 spawned loopback WebSocket client transport', () => {
    it('settles ended handshake stdout while the live child leaves a real stdin write blocked', async () => {
        const child = spawn(process.execPath, ['-e', "process.on('message', () => require('node:fs').closeSync(1)); setInterval(() => {}, 1000)"], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
        const stdin = child.stdin;
        const stdout = child.stdout;
        if (!stdin || !stdout) throw new Error('Fixture pipe handles unavailable');
        const exit = new Promise<Awaited<ExecProcessHandleV1['exit']>>((resolve, reject) => {
            child.once('error', reject);
            child.once('exit', (exitCode, signal) => resolve({ exitCode, signal, stdout: '', stderr: '' }));
        });
        stdin.on('error', () => {});
        const stdoutEnded = new Promise<void>(resolve => { stdout.once('end', resolve); });
        stdout.resume();
        const cancellation = new AbortController();
        let pending: ReturnType<typeof createLoopbackWebSocketProcessClient> | undefined;
        let writeStarted = false;
        let writeSettled = false;
        try {
            const spec = createSpec(process.execPath, {});
            pending = createLoopbackWebSocketProcessClient({
                optionsSignal: cancellation.signal,
                spec: {
                    ...spec,
                    transport: {
                        ...spec.transport,
                        handshake: {
                            byteOrder: 'little-endian',
                            requestFrames: [new Uint8Array(2 * 1024 * 1024)],
                            response: { maxFrameBytes: 4 * 1024 * 1024 },
                        },
                    },
                },
                process: {
                    child: { stdin, stdout },
                    readStderrPreview: () => '',
                    handle: {
                        pid: child.pid ?? null,
                        exit,
                        writeStdin(data) {
                            writeStarted = true;
                            const writing = new Promise<void>((resolve, reject) => {
                                stdin.write(data, error => error ? reject(error) : resolve());
                            });
                            void writing.then(() => { writeSettled = true; }, () => { writeSettled = true; });
                            return writing;
                        },
                        kill: signal => {
                            if (signal === undefined) return child.kill();
                            const signalNumber = Object.entries(constants.signals).find(([name]) => name === signal)?.[1];
                            if (signalNumber === undefined) throw new Error(`Unsupported fixture process signal: ${signal}`);
                            return child.kill(signalNumber);
                        },
                        dispose: async () => { child.kill('SIGKILL'); await exit; },
                    },
                },
            });
            expect(writeStarted).toBe(true);
            expect(writeSettled).toBe(false);
            await new Promise<void>((resolve, reject) => {
                child.send('close-stdout', error => error ? reject(error) : resolve());
            });
            await Promise.race([stdoutEnded, exit.then(() => { throw new Error('Fixture exited before closing stdout'); })]);
            const result = await Promise.race([
                pending.catch((error: unknown) => error),
                new Promise(resolve => setTimeout(() => resolve({ status: 'still_pending' }), 150)),
            ]);
            expect(writeStarted).toBe(true);
            expect(writeSettled).toBe(false);
            expect(child.exitCode).toBeNull();
            expect(child.signalCode).toBeNull();
            expect(result).toMatchObject({ code: 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR' });
        } finally {
            cancellation.abort();
            await pending?.catch(() => undefined);
            child.kill('SIGKILL');
            await exit;
        }
    });

    it('settles a handshake read whose stdout already ended before readiness observation', async () => {
        const stdout = new PassThrough();
        const ended = new Promise<void>(resolve => { stdout.once('end', resolve); });
        stdout.resume();
        stdout.end();
        await ended;
        const result = await Promise.race([
            readLoopbackHandshakeFrame({ stdout, byteOrder: 'little-endian' }).catch((error: unknown) => error),
            new Promise(resolve => setTimeout(() => resolve({ status: 'still_pending' }), 120)),
        ]);
        expect(result).toMatchObject({ code: 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR' });
    });

    it('settles caller cancellation while a handshake endpoint decoder remains pending', async () => {
        const fake = createAlreadyFlowingHandshakeProcess(encodeLoopbackHandshakeFrame('{}', 'little-endian'));
        const spec = createSpec(process.execPath, {});
        const cancellation = new AbortController();
        let markDecoding!: () => void;
        const decoding = new Promise<void>(resolve => { markDecoding = resolve; });
        const pending = createLoopbackWebSocketProcessClient({
            process: fake.process,
            optionsSignal: cancellation.signal,
            spec: {
                ...spec,
                protocol: {
                    ...spec.protocol,
                    endpoint: {
                        decodeHandshakeResponse: () => {
                            markDecoding();
                            return new Promise<ExecLoopbackWebSocketEndpointV1>(() => {});
                        },
                    },
                },
            },
        });
        await decoding;
        cancellation.abort();
        const result = await Promise.race([
            pending.catch((error: unknown) => error),
            new Promise(resolve => setTimeout(() => resolve({ status: 'still_pending' }), 120)),
        ]);
        expect(result).toMatchObject({ code: 'PLUGIN_EXEC_CLIENT_ABORTED' });
    });

    it('delivers a valid burst beyond the former implicit pending-message count after a slow listener resumes', async () => {
        const server = await createHangingUpgradeServer();
        const pending = createLoopbackWebSocketJsonClient({ endpoint: { host: '127.0.0.1', port: server.port } });
        await server.requested;
        server.completeUpgrade();
        const protocol = await pending;
        let resume!: () => void;
        const held = new Promise<void>(resolve => { resume = resolve; });
        const messages: unknown[] = [];
        protocol.client.subscribe(async value => {
            messages.push(value);
            if (value === 0) await held;
        });
        try {
            server.sendJsonBurst(65);
            await Promise.race([server.ponged, protocol.client.closed]);
            resume();
            await expect.poll(() => messages).toEqual(Array.from({ length: 65 }, (_, index) => index));
        } finally {
            resume();
            protocol.dispose();
            await server.close();
        }
    });

    it.each([undefined, 64 * 1024 * 1024])('delivers individually valid frames with aggregate byte budget %s after a slow listener resumes', async (maxBufferedBytes) => {
        const server = await createHangingUpgradeServer();
        const pending = createLoopbackWebSocketJsonClient({
            endpoint: { host: '127.0.0.1', port: server.port },
            ...(maxBufferedBytes === undefined ? {} : { limits: { maxBufferedBytes } }),
        });
        let protocol: Awaited<typeof pending> | undefined;
        let resume!: () => void;
        const held = new Promise<void>(resolve => { resume = resolve; });
        const messages: unknown[] = [];
        try {
            await Promise.race([server.requested, pending]);
            server.completeUpgrade();
            protocol = await pending;
            protocol.client.subscribe(async value => {
                messages.push(value);
                if (messages.length === 1) await held;
            });
            server.sendJsonBurst(60, 20_000);
            await Promise.race([server.ponged, protocol.client.closed]);
            resume();
            await expect.poll(() => messages.length).toBe(60);
            expect(messages).toEqual(Array.from({ length: 60 }, (_, index) => ({ index, payload: 'x'.repeat(20_000) })));
        } finally {
            resume();
            protocol?.dispose();
            await pending.catch(() => undefined);
            await server.close();
        }
    });

    it.each([undefined, 65_000])('honors an omitted or authored connection budget %s beyond the former 60-second clamp', async (timeoutMs) => {
        const server = await createHangingUpgradeServer();
        const cancellation = new AbortController();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const monotonicClock = vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
        let settled = false;
        const pending = createLoopbackWebSocketJsonClient({
            endpoint: { host: '127.0.0.1', port: server.port },
            ...(timeoutMs === undefined ? {} : { connect: { timeoutMs } }),
            signal: cancellation.signal,
        });
        void pending.then(() => { settled = true; }, () => { settled = true; });
        try {
            await server.requested;
            await vi.advanceTimersByTimeAsync(61_000);
            expect(settled).toBe(false);
            server.completeUpgrade();
            const protocol = await pending;
            protocol.dispose();
        } finally {
            cancellation.abort();
            await pending.catch(() => undefined);
            monotonicClock.mockRestore();
            vi.useRealTimers();
            await server.close();
        }
    });

    it('does not lose a synchronous child handshake response when stdout diagnostics are already flowing', async () => {
        const responseFrame = encodeLoopbackHandshakeFrame(
            Buffer.from(JSON.stringify({
                host: 'example.com',
                port: 12_345,
                path: '/runtime',
                apiKey: 'race-key',
            })),
            'little-endian',
        );
        const fake = createAlreadyFlowingHandshakeProcess(responseFrame);
        const spec = createSpec(process.execPath, { apiKey: 'race-key' });

        await expect(createLoopbackWebSocketProcessClient({
            spec: {
                ...spec,
                transport: {
                    ...spec.transport,
                    handshake: {
                        ...spec.transport.handshake,
                        response: {
                            ...spec.transport.handshake.response,
                            timeoutMs: 25,
                        },
                    },
                },
            },
            process: fake.process,
        })).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR',
        });
        expect(fake.wroteStdin()).toBe(true);
    });

    it('rejects endpoint paths with HTTP control characters before sending a WebSocket upgrade request', async () => {
        const probe = await createRawLoopbackProbe();
        try {
            const responseFrame = encodeLoopbackHandshakeFrame(
                Buffer.from(JSON.stringify({
                    host: '127.0.0.1',
                    port: probe.port,
                    path: '/runtime\r\nX-Injected: yes',
                    apiKey: 'path-injection-key',
                })),
                'little-endian',
            );
            const fake = createAlreadyFlowingHandshakeProcess(responseFrame);
            const spec = createSpec(process.execPath, { apiKey: 'path-injection-key' });

            await expect(createLoopbackWebSocketProcessClient({
                spec: {
                    ...spec,
                    transport: {
                        ...spec.transport,
                        connect: {
                            timeoutMs: 40,
                            retryInitialDelayMs: 5,
                            retryMaxDelayMs: 5,
                        },
                    },
                },
                process: fake.process,
            })).rejects.toMatchObject({
                code: 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR',
            });
            expect(probe.received().toString('latin1')).toBe('');
        } finally {
            await probe.close();
        }
    });

    it('does not retry a completed socket upgrade failure as loopback readiness', async () => {
        const probe = await createRawLoopbackProbe();
        try {
            const responseFrame = encodeLoopbackHandshakeFrame(
                Buffer.from(JSON.stringify({
                    host: '127.0.0.1',
                    port: probe.port,
                    path: '/runtime',
                    apiKey: 'upgrade-rejected-key',
                })),
                'little-endian',
            );
            const fake = createAlreadyFlowingHandshakeProcess(responseFrame);
            const spec = createSpec(process.execPath, { apiKey: 'upgrade-rejected-key' });

            await expect(createLoopbackWebSocketProcessClient({
                spec: {
                    ...spec,
                    transport: {
                        ...spec.transport,
                        connect: {
                            timeoutMs: 80,
                            retryInitialDelayMs: 5,
                            retryMaxDelayMs: 5,
                        },
                    },
                },
                process: fake.process,
            })).rejects.toMatchObject({
                code: 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR',
            });
        } finally {
            await probe.close();
        }
    });

    it('times out when a loopback socket accepts TCP but never completes the WebSocket upgrade', async () => {
        const server = await createHangingUpgradeServer();
        const connectPromise = createLoopbackWebSocketJsonClient({
            endpoint: { url: `ws://127.0.0.1:${server.port}/runtime` },
            connect: {
                timeoutMs: 35,
                retryInitialDelayMs: 5,
                retryMaxDelayMs: 5,
            },
        });
        connectPromise.catch(() => undefined);

        try {
            const result: unknown = await Promise.race([
                connectPromise.catch((error: unknown) => error),
                new Promise((resolve) => {
                    setTimeout(() => resolve({ status: 'still_pending' }), 120);
                }),
            ]);

            expect(result).toMatchObject({
                code: 'PLUGIN_EXEC_CLIENT_REQUEST_TIMEOUT',
            });
        } finally {
            await server.close();
        }
    });

});
