import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { CapabilitiesInvokeRequest } from '@/sync/api/capabilities/capabilitiesProtocol';
import { createPlainAccountEncryptionCurrentnessFixture } from '../fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '../fixtures/featureFixtures';
import { installBrowserRuntimeForTests } from './browserRuntimeHarness';
import { installSessionOpsNetworkBoundary } from './sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from './syncSingletonLoader';

export type PreflightCapabilityResponder = (
    machineId: string,
    request: CapabilitiesInvokeRequest,
    options: Readonly<{ serverId: string; timeoutMs: number | null }>,
) => Promise<unknown>;

/**
 * Real inventory Actions and caches, with only browser persistence and Home/daemon network replaced.
 * Install once during collection, await reset() before each case, and dispose after the suite.
 */
export async function installNewSessionPreflightHarness(respond: PreflightCapabilityResponder, options: Readonly<{
    /** Persistence tests retain their browser storage while reloading the runtime graph. */
    installBrowser?: boolean;
}> = {}) {
    let browser = options.installBrowser === false ? null
        : await installBrowserRuntimeForTests({ url: 'https://new-session-preflight.test/' });
    const network = await installSessionOpsNetworkBoundary();
    const home = await network.addHome('https://new-session-preflight.test', 'preflight-account');
    const respondHttp: Parameters<typeof network.setHttpResponder>[0] = async input => {
        const path = new URL(String(input)).pathname;
        if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
        if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 0 });
        if (path === '/v1/account/entity-rows/profiles/transfer') return Response.json({ status: 'absent' });
        return null;
    };
    let responder = respond;
    const respondRpc: Parameters<typeof network.setRpcResponder>[0] = async request => {
        if (request.method !== RPC_METHODS.CAPABILITIES_INVOKE) throw new Error(`Unexpected preflight daemon method: ${request.method}`);
        return await responder(request.targetId, request.payload as CapabilitiesInvokeRequest,
            { serverId: home.id, timeoutMs: request.timeoutMs });
    };
    const configure = () => {
        responder = respond;
        network.resetRequests();
        network.setHttpResponder(respondHttp);
        network.setRpcResponder(respondRpc);
    };
    configure();
    const reset = async () => {
        // The canonical suite setup clears DOM globals and physical device storage.
        // Reapply those boundaries per case while retaining the already-imported Socket transport.
        if (options.installBrowser !== false) {
            browser?.restore();
            browser = await installBrowserRuntimeForTests({ url: 'https://new-session-preflight.test/' });
        }
        await network.addHome(home.serverUrl, 'preflight-account');
        configure();
    };
    const sync = await loadSyncSingletonForTests();
    return {
        serverId: home.id,
        network,
        reset,
        respondHttp,
        respondRpc,
        setCapabilityResponder(next: PreflightCapabilityResponder) { responder = next; },
        async dispose() {
            try { await network.dispose(); }
            finally { sync.dispose(); browser?.restore(); }
        },
    };
}
