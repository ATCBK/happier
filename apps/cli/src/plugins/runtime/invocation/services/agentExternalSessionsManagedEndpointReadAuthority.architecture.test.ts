import { access, readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const cliSource = new URL('../../../../', import.meta.url);
const sourceFile = (path: string) => new URL(path, cliSource);

describe('Agent External Sessions managed endpoint read authority', () => {
    it('removes the rejected daemon passive-resolution host', async () => {
        await expect(access(sourceFile(
            'plugins/runtime/invocation/services/daemonAgentExternalSessionsManagedEndpointReadHost.ts',
        ))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('wires the daemon owner through one ready callback instead of a permanent unavailable stub', async () => {
        const startDaemon = await readFile(sourceFile('daemon/startDaemon.ts'), 'utf8');
        const sessionControlRuntime = await readFile(sourceFile(
            'daemon/startup/startDaemonSessionControlRuntime.ts',
        ), 'utf8');

        expect(startDaemon).not.toContain(
            'createUnavailableAgentExternalSessionsManagedEndpointRead',
        );
        expect(startDaemon).toContain('managedServiceEndpointReadHost');
        expect(startDaemon).toContain('onManagedServiceEndpointReadHostReady');
        expect(sessionControlRuntime).toContain(
            'params.onManagedServiceEndpointReadHostReady?.(',
        );
    });
});
