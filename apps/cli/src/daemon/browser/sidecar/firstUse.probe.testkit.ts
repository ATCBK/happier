import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DaemonRuntimeActionRouteOwners } from '../../runtimeActionExecutor';

const home = await mkdtemp(join(tmpdir(), 'happier-fx20-probe-'));
process.env.HAPPIER_HOME_DIR = home;
const archive = Buffer.from('UEsDBBQAAAAAAKCqIl2/ze6ZDgAAAA4AAAASAAAAYWd5X2FjcF9zZXJ2ZXIucGFyc2VydmVyLWZpeHR1cmVQSwMEFAAAAAAAoKoiXeOBVF8PAAAADwAAABUAAABsb2NhbGhhcm5lc3NfZXh0ZXJuYWxoYXJuZXNzLWZpeHR1cmVQSwECFAMUAAAAAACgqiJdv83umQ4AAAAOAAAAEgAAAAAAAAAAAAAA7YEAAAAAYWd5X2FjcF9zZXJ2ZXIucGFyUEsBAhQDFAAAAAAAoKoiXeOBVF8PAAAADwAAABUAAAAAAAAAAAAAAO2BPgAAAGxvY2FsaGFybmVzc19leHRlcm5hbFBLBQYAAAAAAgACAIMAAACAAAAAAAA=', 'base64');
const server = createServer((_request, response) => response.end(archive));
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert(address && typeof address !== 'string');
const asset = { archiveUrl: `http://127.0.0.1:${address.port}/browser.zip`, executableSubpath: 'agy_acp_server.par',
    integrityDigest: `sha256:${createHash('sha256').update(archive).digest('hex')}` };
const { FeaturesResponseSchema } = await import('@happier-dev/protocol');
const { getActionSpec } = await import('@happier-dev/protocol/actions/actionSpecs');
const { BrowserOpenViewInProgressV1Schema, BrowserCommandDispatchResultV1Schema } = await import('@happier-dev/protocol/browser/control/v1');
const { installChromiumForTesting } = await import('../../../packagedRuntime/installables/sourceAdapters/chromiumForTesting.ts');
const { resolveManagedBrowserSidecarCandidate } = await import('./source.ts');
const { createBrowserAutomationRuntimeProvisioner } = await import('./provisioning.ts');
const { createBrowserDaemonControlBroker } = await import('../control/broker.ts');
const { createBrowserDaemonControlRoutes } = await import('../control/routes.ts');
const { createBrowserSidecarCdpControlAdapter } = await import('./controlAdapter.ts');
const { createDaemonRuntimeActionExecutor } = await import('../../runtimeActionExecutor.ts');
const { createHostActionOperationRuntime } = await import('../../actionOperations/createHostActionOperationRuntime.ts');
let release!: () => void;
const hold = new Promise<void>(resolve => { release = resolve; });
let installation: ReturnType<typeof installChromiumForTesting> | undefined;
let routeRefreshed!: () => void;
const refreshed = new Promise<void>(resolve => { routeRefreshed = resolve; });
const broker = createBrowserDaemonControlBroker();
let routes: DaemonRuntimeActionRouteOwners = {};
let opened = 0;
const provisioner = createBrowserAutomationRuntimeProvisioner({ platform: 'linux', arch: 'x64',
    resolveManagedCandidate: params => resolveManagedBrowserSidecarCandidate({ ...params, assetOverride: asset }),
    installManagedBrowserChromium: params => {
        const installing = hold.then(() => installChromiumForTesting({ ...params, asset }));
        installation = installing;
        return installing;
    },
    refreshRouteOwners: async () => {
        assert.equal((await resolveManagedBrowserSidecarCandidate({ platform: 'linux', arch: 'x64', assetOverride: asset }))?.available, true);
        broker.registerAdapter(createBrowserSidecarCdpControlAdapter({ browserSessionId: 'session', sidecarId: 'sidecar',
            transport: { openPage: async () => { opened++; return { targetId: 'target', sessionId: 'cdp' }; },
                dispatchPageCommand: async () => ({}), dispatchBrowserCommand: async () => ({}) } }));
        routes = { ...routes, browserControl: createBrowserDaemonControlRoutes({ broker }) };
        routeRefreshed();
    },
});
routes = { provisionBrowserAutomationRuntime: provisioner.provision };
const operations = createHostActionOperationRuntime({ machineId: 'machine', resolveAccountId: async () => 'account', generateOperationId: () => 'first-use' });
const execute = createDaemonRuntimeActionExecutor({ env: { NODE_ENV: 'test' }, resolveRouteOwners: () => routes,
    observeExecution: operations.observeExecution,
    resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: {
        browser: { enabled: true, viewTargets: { enabled: true }, internal: { enabled: true }, sidecar: { enabled: true } },
    } }) }),
});
try {
    const result = await execute({ actionId: 'browser.view.open', input: { kind: 'openView', commandId: 'original', browserSessionId: 'session',
        viewId: 'view', platform: 'web', target: { kind: 'externalUrl', targetId: 'target', url: 'https://fixture.invalid' } }, context: {
            authority: 'account_automation', surface: 'agent', bypassApprovals: true,
            externalActionTarget: { kind: 'machine', machineId: 'machine' },
        } });
    const accepted = BrowserOpenViewInProgressV1Schema.parse(result);
    assert.equal(accepted.status, 'in_progress', 'first approved open must be accepted while provisioning');
    const outputSchema = getActionSpec('browser.view.open').outputSchema;
    assert(outputSchema);
    assert(outputSchema.safeParse(result).success);
    release();
    const terminal = await operations.runner.waitForTerminal({ accountId: 'account', machineId: 'machine' }, 'first-use');
    assert.equal(terminal?.state, 'succeeded');
    assert.equal(BrowserCommandDispatchResultV1Schema.parse(terminal?.result).commandId, 'original');
    assert.equal(opened, 1);
    assert.equal(broker.listViews('session').length, 1);
    console.log('FX20 composed source probe PASS');
} finally {
    release();
    if (installation) {
        const installed = await installation;
        if (installed.ok) await refreshed;
        else console.error('Fixture install failed:', installed.errorCode);
    }
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(home, { recursive: true, force: true });
}
