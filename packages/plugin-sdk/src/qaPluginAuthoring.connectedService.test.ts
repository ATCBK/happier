import { describe, expect, it } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type {
    ConnectedAccountAuthenticationContext,
    ConnectedAccountCredentialStore,
    ConnectedAccountReadContext,
} from '@happier-dev/plugin-sdk/connected-accounts';

import * as plugin from '../fixtures/qa-plugin-authoring/qa-connected-service/index.js';

const hostInvocation = {
    plugin: { id: plugin.manifest.id, version: plugin.manifest.version },
    contribution: { id: 'demo', qualifiedId: `${plugin.manifest.id}/demo` },
    surface: 'background',
    invokedAtMs: 1,
    // This fixture admits only credential storage; unexpected host-service reads fail closed.
    services: new Proxy({} as ConnectedAccountReadContext['services'], {
        get() { throw new Error('QA host invocation services are not admitted'); },
    }),
} satisfies Pick<ConnectedAccountReadContext, 'plugin' | 'contribution' | 'surface' | 'invokedAtMs' | 'services'>;

// Only the host credential-storage boundary is faked; the registered producer is real.
function credentialStore() {
    const values = new Map<string, string>();
    const store = {
        async get(key: string) { return values.get(key) ?? null; },
        async set(key: string, value: string) { values.set(key, value); },
        async delete(key: string) { values.delete(key); },
    } satisfies ConnectedAccountCredentialStore;
    return store;
}

function authenticationContext(store: ConnectedAccountCredentialStore, attemptId = 'qa-attempt-1', signal = new AbortController().signal) {
    const service = { pluginId: 'qa.public-connected-service', localId: 'demo' };
    const boundary = {
        ...hostInvocation,
        service,
        attempt: { kind: 'connect', attemptId },
        configuration: {
            target: { kind: 'attempt', attemptId, service, modeId: 'manual' },
            revision: 'qa-config-1', values: {}, async getSecret() { return null; },
        },
        attemptCredentials: store,
        signal,
    } satisfies ConnectedAccountAuthenticationContext;
    return boundary;
}

function readContext(store: ConnectedAccountCredentialStore) {
    const account = { service: { pluginId: 'qa.public-connected-service', localId: 'demo' }, accountId: 'qa-host-account-1' };
    const boundary = {
        ...hostInvocation,
        account,
        configuration: {
            target: { kind: 'account', account, modeId: 'manual' },
            revision: 'qa-config-1', values: {}, async getSecret() { return null; },
        },
        credentials: store,
        signal: new AbortController().signal,
    } satisfies ConnectedAccountReadContext;
    return boundary;
}

describe('QA public connected-service authoring', () => {
    it('publishes a static title and stages a fake manual credential without minting an account', async () => {
        const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin });
        try {
            expect(plugin.manifest.contributes?.connectedAccountDescriptors)
                .toContainEqual(expect.objectContaining({ id: 'demo', title: 'QA Demo service' }));
            const runtime = kit.registration('connectedAccountDescriptors', 'demo');
            if (!runtime) throw new Error('Missing admitted QA producer');
            const mode = runtime.authentication.modes.manual;
            if (mode?.kind !== 'manual') throw new Error('Missing manual QA mode');
            const store = credentialStore();
            for (const attemptId of ['qa-attempt-1', 'qa-attempt-2']) {
                const result = await mode.complete({ fields: { token: 'qa-demo-token' } }, authenticationContext(store, attemptId));
                expect(result).toEqual({ status: 'connected', displayName: 'QA Demo account', scopes: [] });
            }
            await expect(runtime.status(readContext(store))).resolves.toMatchObject({ status: 'connected' });
            await expect(runtime.materialize({ kind: 'httpHeaders', origin: 'https://qa-service.example.test',
                headerNames: ['authorization'] }, readContext(store)))
                .resolves.toEqual({ kind: 'httpHeaders', headers: { authorization: 'Bearer qa-demo-token' } });
            await expect(runtime.materialize({ kind: 'httpHeaders', origin: 'https://other.example.test',
                headerNames: ['authorization'] }, readContext(store))).rejects.toThrow();
        } finally {
            await kit.dispose();
        }
    });

    it('rejects invalid credentials, keeps failed staging unsettled, and reports unavailable reads', async () => {
        const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin });
        try {
            const runtime = kit.registration('connectedAccountDescriptors', 'demo');
            if (!runtime) throw new Error('Missing admitted QA producer');
            const mode = runtime.authentication.modes.manual;
            if (mode?.kind !== 'manual') throw new Error('Missing manual QA mode');
            const store = credentialStore();
            await expect(mode.complete({ fields: { token: 'invalid-demo-token' } }, authenticationContext(store)))
                .resolves.toMatchObject({ status: 'rejected', diagnostic: { code: 'qa_credential_invalid' } });
            await expect(store.get('token')).resolves.toBeNull();
            await expect(runtime.status(readContext(store))).resolves.toMatchObject({ status: 'unavailable' });
            await expect(runtime.materialize({ kind: 'httpHeaders', origin: 'https://qa-service.example.test',
                headerNames: ['authorization'] }, readContext(store))).rejects.toThrow();
            const failedStore = { ...store, async set() { throw new Error('QA host credential storage unavailable'); } };
            await expect(mode.complete({ fields: { token: 'qa-demo-token' } }, authenticationContext(failedStore)))
                .rejects.toThrow(/storage unavailable/u);
            const cancellation = new AbortController();
            cancellation.abort();
            await expect(mode.complete({ fields: { token: 'qa-demo-token' } }, authenticationContext(store, 'qa-attempt-1', cancellation.signal))).rejects.toMatchObject({ name: 'AbortError' });
            await expect(store.get('token')).resolves.toBeNull();
            await expect(runtime.revoke(readContext(store))).resolves.toEqual({ status: 'remoteUnsupported' });
        } finally {
            await kit.dispose();
        }
    });
});
