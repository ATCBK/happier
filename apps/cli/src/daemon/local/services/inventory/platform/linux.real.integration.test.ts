import { once } from 'node:events';
import { readFile, readdir, readlink } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { readLinuxLocalServiceListeners } from './linux';

describe.skipIf(process.platform !== 'linux')('Linux local-service native socket facts', () => {
    it('observes zero visitors and then a real established client at the same listener', async () => {
        const server = createServer();
        let client: Socket | undefined;
        let accepted: Socket | undefined;
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('TCP listener unavailable');
        const readListener = async () => (await readLinuxLocalServiceListeners({ readFile, readdir, readlink }))
            .listeners.find(listener => listener.pid === process.pid && listener.port === address.port);
        try {
            expect(await readListener()).toMatchObject({ establishedConnections: 0 });
            const incoming = once(server, 'connection');
            client = createConnection({ host: '127.0.0.1', port: address.port });
            await once(client, 'connect');
            [accepted] = await incoming as [Socket];
            expect(await readListener()).toMatchObject({ establishedConnections: 1 });
        } finally {
            client?.destroy();
            accepted?.destroy();
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });
});
