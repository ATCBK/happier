import { createServer } from 'node:http';
import { once } from 'node:events';
import Fastify from 'fastify';
import { Server } from 'socket.io';
import { io as createClient } from 'socket.io-client';
import { describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { FeaturesResponseSchema, PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, PeerTcpTunnelRelayEnvelopeSchema, decodePeerTcpTunnelBinaryFrameV2, type LocalServicePreviewResourceV1 } from '@happier-dev/protocol';
import { TEST_MACHINE_INSTALLATION_ID } from '@/app/api/testkit/machineAdmissionPersistenceBoundary';
import { createPeerTcpTunnelRelayBridge } from '@/app/api/socket/peer/mediation/tunnel/relayBridge';
import { createPeerTcpTunnelRelayCoordinator } from '@/app/api/socket/peer/mediation/tunnel/relayCoordinator';
import { registerPeerTcpTunnelRelaySocketHandler } from '@/app/api/socket/peer/mediation/tunnel/registerRelay';
import { registerLocalServicePreviewRoutes } from '@/app/api/routes/local/services/preview/registerRoutes';
import { registerMachinePeerTcpTunnelRelayRuntime } from '../../../../../../cli/src/daemon/machine/registerMachinePeerTcpTunnelRelayRuntime';
import { createLocalServicePreviewRuntime } from './runtime';
import { createLocalServicePreviewTunnelOpener } from './tunnel';

// Persistence is the system boundary; the real Machine admission owner evaluates its rows.
vi.mock('@/storage/db', async () => {
    const { createMachineAdmissionPersistenceBoundary } = await import('@/app/api/testkit/machineAdmissionPersistenceBoundary');
    return { db: createMachineAdmissionPersistenceBoundary('user_1').db };
});

describe('private preview HTTP through the server relay and daemon TCP terminator', () => {
    it('returns the fixture body after admission exchange and forwards a tokenless subresource', async () => {
        const paths: string[] = [];
        const wireTrace: string[] = [];
        const closeTransports: (() => void)[] = [];
        function recordFrame(direction: string, payload: unknown): void {
            const parsed = PeerTcpTunnelRelayEnvelopeSchema.safeParse(payload);
            if (!parsed.success) { wireTrace.push(`${direction}:invalid`); return; }
            const envelope = parsed.data;
            if (envelope.v === 1) {
                wireTrace.push(`${direction}:${envelope.frame.kind}${envelope.frame.kind === 'abort' ? `:${envelope.frame.reasonCode}` : ''}`);
            } else {
                const decoded = decodePeerTcpTunnelBinaryFrameV2({ frame: envelope.frame, maxHeaderBytes: 64 * 1024, maxPayloadBytes: 256 * 1024 });
                wireTrace.push(`${direction}:${decoded.ok ? decoded.header.kind : 'invalid-binary'}`);
            }
        }
        const fixture = createServer((request, response) => {
            paths.push(request.url ?? '');
            response.setHeader('content-type', 'text/plain');
            response.end(`fixture:${request.url}`);
        });
        fixture.listen(0, '127.0.0.1');
        await once(fixture, 'listening');
        const address = fixture.address();
        if (!address || typeof address === 'string') throw new Error('missing fixture address');
        const relayHttp = createServer();
        const io = new Server(relayHttp, { transports: ['websocket'] });
        relayHttp.listen(0, '127.0.0.1');
        await once(relayHttp, 'listening');
        const relayAddress = relayHttp.address();
        if (!relayAddress || typeof relayAddress === 'string') throw new Error('missing relay address');
        const bridge = createPeerTcpTunnelRelayBridge(io);
        const coordinator = createPeerTcpTunnelRelayCoordinator({ io, config: { mode: 'memory' } });
        const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23));
        const roots = [{ keyId: 'fixture-key', publicKeyBase64Url: Buffer.from(key.publicKey).toString('base64url') }];
        const handlerOptions = { io: bridge.io, coordinator, serverRoutedEnabled: true, allowedPorts: [address.port], relayAuthorizationTrustRoots: roots };
        io.on('connection', socket => {
            socket.data = { userId: 'user_1', clientType: 'machine-scoped', machineId: 'machine_1', verifiedMachineInstallationId: TEST_MACHINE_INSTALLATION_ID };
            void socket.join('machine:machine_1:user_1');
            registerPeerTcpTunnelRelaySocketHandler('user_1', socket, handlerOptions);
        });
        const client = createClient(`http://127.0.0.1:${relayAddress.port}`, { transports: ['websocket'], autoConnect: false });
        client.onAny((event, payload: unknown) => { if (event === PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT) recordFrame('server-to-daemon', payload); });
        client.onAnyOutgoing((event, payload: unknown) => { if (event === PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT) recordFrame('daemon-to-server', payload); });
        const daemon = registerMachinePeerTcpTunnelRelayRuntime({
            accountId: 'user_1', machineId: 'machine_1', nowMs: Date.now,
            serverFeatures: FeaturesResponseSchema.parse({
                features: { machines: { enabled: true, tunnel: { enabled: true, serverRouted: { enabled: true } } } },
                capabilities: { machines: { peerMediation: { grantSigningKeys: roots.map(root => ({ keyId: root.keyId, publicKey: root.publicKeyBase64Url })) } } },
            }),
            eventPort: {
                subscribe: listener => { client.on(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, listener); return () => { client.off(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, listener); }; },
                emit: envelope => { client.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, envelope); },
            },
            onHandlerError: error => { wireTrace.push(`daemon-handler-error:${String(error)}`); },
        });
        if (!daemon) throw new Error('enabled daemon relay was not registered');
        client.connect();
        await once(client, 'connect');
        const runtime = createLocalServicePreviewRuntime({ tokenSecret: 'fixture-secret', publicBaseUrl: 'https://home.example.test', hostOriginBaseDomain: 'example.test' });
        const preview: LocalServicePreviewResourceV1 = {
            previewId: 'preview_fixture', sessionId: 'session_fixture', machineId: 'machine_1',
            owner: { kind: 'session', id: 'session_fixture' },
            target: { scheme: 'http', host: '127.0.0.1', port: address.port },
            initialPath: { pathname: '/body', search: '' }, display: { title: 'fixture', addressLabel: 'fixture' }, originMode: 'host',
        };
        const registered = runtime.registerPreview({ resource: preview, accountId: 'user_1' });
        if (!registered.ok || !registered.accessUrl) throw new Error('fixture registration failed');
        const openTunnel = createLocalServicePreviewTunnelOpener({
            env: { HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__ENABLED: 'true', HAPPIER_FEATURE_MACHINES_TUNNEL_ALLOWED_PORTS: String(address.port), HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: 'fixture-key', HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: Buffer.from(key.secretKey).toString('base64url') },
            resolvePreviewAccountId: id => runtime.resolvePreviewContext(id)?.accountId,
            createRelayTransport: ({ accountId }) => {
                const transport = bridge.createTransport({ accountId });
                const handlers = new Map<string, (payload?: unknown) => void | Promise<void>>();
                registerPeerTcpTunnelRelaySocketHandler(accountId, {
                    id: transport.relaySocketId, data: { clientType: 'user-scoped' },
                    on: (event, handler) => handlers.set(event, handler), emit: (_event, payload) => { wireTrace.push(`server-error:${JSON.stringify(payload)}`); },
                }, handlerOptions);
                const close = () => { void handlers.get('disconnect')?.(); transport.close(); };
                closeTransports.push(close);
                return { ...transport, send: (event, payload) => { recordFrame('preview-to-server', payload); void handlers.get(event)?.(payload); }, close };
            },
        });
        const app = Fastify();
        app.decorate('authenticate', async () => {});
        registerLocalServicePreviewRoutes(app as never, {
            resolvePreview: runtime.resolvePreview, resolvePreviewByHost: runtime.resolvePreviewByHost,
            validateAccess: runtime.validateAccess, exchangeAccessToken: runtime.exchangeAccessToken,
            retainConnection: runtime.retainConnection, hostOriginBaseDomain: 'example.test', openTunnel,
        });
        try {
            const url = new URL(registered.accessUrl);
            const exchange = await app.inject({ method: 'GET', url: url.pathname + url.search, headers: { host: url.host } });
            expect(exchange.statusCode).toBe(303);
            const cookie = String(exchange.headers['set-cookie']).split(';')[0];
            const bodyRequest = app.inject({ method: 'GET', url: '/body', headers: { host: url.host, cookie } });
            void bodyRequest.catch(() => undefined);
            await expect.poll(() => paths, { timeout: 5000, message: 'the admitted preview reaches the HTTP fixture' }).toEqual(['/body']);
            const body = await bodyRequest;
            expect(body.statusCode).toBe(200);
            expect(body.body).toBe('fixture:/body');
            const asset = await app.inject({ method: 'GET', url: '/asset.js', headers: { host: url.host, cookie } });
            expect(asset.statusCode).toBe(200);
            expect(asset.body).toBe('fixture:/asset.js');
            expect(paths).toEqual(['/body', '/asset.js']);
        } catch (error) {
            throw new Error(`Preview transport trace: ${JSON.stringify(wireTrace)}`, { cause: error });
        } finally {
            for (const close of closeTransports) close();
            await daemon.dispose();
            client.disconnect();
            await coordinator.close();
            await new Promise<void>(resolve => io.close(() => resolve()));
            await app.close();
            fixture.closeAllConnections();
            await new Promise<void>(resolve => fixture.close(() => resolve()));
        }
    });
});
