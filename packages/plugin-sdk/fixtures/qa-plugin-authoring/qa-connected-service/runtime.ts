import type {
    ConnectedAccountHealthResult,
    ConnectedAccountMaterialization,
    ConnectedAccountRuntime,
} from '@happier-dev/plugin-sdk/connected-accounts';

const DEMO_TOKEN = 'qa-demo-token';
const DEMO_ORIGIN = 'https://qa-service.example.test';
type CredentialReader = Parameters<ConnectedAccountRuntime['status']>[0]['credentials'];

async function readHealth(credentials: CredentialReader): Promise<ConnectedAccountHealthResult> {
    return await credentials.get('token') === DEMO_TOKEN
        ? { status: 'connected', displayName: 'QA Demo account', scopes: [] }
        : { status: 'unavailable', diagnostic: { code: 'qa_credential_unavailable', severity: 'error' } };
}

/** No external service exists: only the host's fake-token credential boundary is exercised. */
export const demoRuntime: ConnectedAccountRuntime = {
    authentication: { modes: { manual: {
        kind: 'manual',
        async complete(input, context) {
            context.signal.throwIfAborted();
            if (input.fields.token !== DEMO_TOKEN) {
                return { status: 'rejected', diagnostic: { code: 'qa_credential_invalid', severity: 'error' } };
            }
            await context.attemptCredentials.set('token', DEMO_TOKEN, { signal: context.signal });
            // The host settles the attempt and mints the account identity on first connect.
            return { status: 'connected', displayName: 'QA Demo account', scopes: [] };
        },
    } } },
    async refresh(context) { return readHealth(context.credentials); },
    async status(context) { return readHealth(context.credentials); },
    async revoke() { return { status: 'remoteUnsupported' }; },
    async materialize(request, context): Promise<ConnectedAccountMaterialization> {
        const token = await context.credentials.get('token');
        if (token !== DEMO_TOKEN) throw new Error('QA credential is unavailable');
        if (request.kind !== 'httpHeaders' || request.origin !== DEMO_ORIGIN
            || request.headerNames.some((name) => name.toLowerCase() !== 'authorization')) {
            throw new TypeError('QA service supports only its declared authorization header origin');
        }
        return { kind: 'httpHeaders', headers: request.headerNames.length === 0 ? {} : { authorization: `Bearer ${token}` } };
    },
};
