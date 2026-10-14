import { vi } from 'vitest';
import { loadVitestModuleForNodeRequire } from '@/dev/vitestRnShim';
import { getVitestNodeBuiltin } from '@/dev/vitestNodeBuiltins';
import type { AuthCredentials, HomeCredentialWriteRollback } from '@/auth/storage/tokenStorage';
import { AuthTokenProvenanceSchema } from '@happier-dev/protocol/auth/authToken';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import {
    AccountSettingsV2GetResponseSchema,
    AccountSettingsV2UpdateRequestAdmissionSchema,
    AccountSettingsV2UpdateRequestSchema,
    AccountSettingsV2UpdateResponseSchema,
    type AccountSettingsV2GetResponse,
} from '@happier-dev/protocol/account/settings/accountSettingsApiV2';

// File identities belong to Node, not Vite's client asset URL transform.
const { URL: NodeURL } = getVitestNodeBuiltin<typeof import('node:url')>('node:url');

// A generated third-party WebView asset is not part of an HTTP Action journey. Its multi-MB
// source otherwise enters the default executor's presentation import graph during collection.
vi.mock('@/components/markdown/mermaidWebViewBundle.generated', () => ({
    MERMAID_WEBVIEW_BUNDLE_JS: '', MERMAID_WEBVIEW_BUNDLE_BYTES: 0,
}));

export type ServedHomeRequest = Readonly<{
    home: string;
    method: string;
    path: string;
    url: URL;
    /** The Account the request authenticated as (the bearer token's subject). */
    accountId: string | null;
    headers: Headers;
    body: unknown;
    signal: AbortSignal | null | undefined;
}>;

type HomeSpec = Readonly<{ key: string; serverUrl: string; serverIdentityId?: string; accountId: string; settings?: Readonly<Record<string, unknown>>;
    accountMode?: 'plain' | 'e2ee'; credentials?: AuthCredentials; currentAccount?: boolean }>;

function tokenFor(accountId: string, currentAccount = false): string {
    return `header.${Buffer.from(JSON.stringify({ sub: accountId, ...(currentAccount ? {
        provenance: AuthTokenProvenanceSchema.parse({ v: 1, kind: 'account', authority: 'present_user' }), tokenEpoch: 0,
    } : {}) })).toString('base64url')}.signature`;
}

function accountOf(init: RequestInit | undefined): string | null {
    const header = new Headers(init?.headers).get('Authorization');
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
    const payload = token?.split('.')[1];
    if (!payload) return null;
    try {
        return (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: string }).sub ?? null;
    } catch {
        return null;
    }
}

/**
 * One Home's external Settings server. It owns only wire snapshots and CAS;
 * creating it does not activate a Home, write credentials, or publish UI state.
 */
export function createAccountSettingsHttpBoundary(params: Readonly<{
    serverUrl: string;
    initialAccounts: readonly Readonly<{ accountId: string; snapshot: AccountSettingsV2GetResponse }>[];
}>) {
    const origin = new URL(params.serverUrl).origin;
    const settingsByAccount = new Map<string, AccountSettingsV2GetResponse>();
    function replaceAccountSettings(accountId: string, snapshot: AccountSettingsV2GetResponse) {
        // JSON copies the external server fact, never a live client projection.
        settingsByAccount.set(accountId, AccountSettingsV2GetResponseSchema.parse(JSON.parse(JSON.stringify(snapshot))));
    }
    for (const account of params.initialAccounts) replaceAccountSettings(account.accountId, account.snapshot);
    return {
        replaceAccountSettings,
        handle(url: RequestInfo | URL, init?: RequestInit): Response | undefined {
            const target = new URL(String(url));
            if (target.origin !== origin || target.pathname !== '/v2/account/settings') return undefined;
            const accountId = accountOf(init);
            if (!accountId) {
                const error = new Headers(init?.headers).has('Authorization') ? 'invalid_token' : 'Missing authorization header';
                return Response.json({ error }, { status: 401 });
            }
            const current = settingsByAccount.get(accountId) ?? { content: null, version: 0 };
            if ((init?.method ?? 'GET') === 'GET') {
                return Response.json(AccountSettingsV2GetResponseSchema.parse(current));
            }
            if (init?.method !== 'POST') return undefined;
            let body: unknown;
            try {
                body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
            } catch {
                return Response.json({ error: 'invalid-params' }, { status: 400 });
            }
            if (!AccountSettingsV2UpdateRequestAdmissionSchema.safeParse(body).success) {
                return Response.json({ error: 'invalid-params' }, { status: 400 });
            }
            const parsed = AccountSettingsV2UpdateRequestSchema.safeParse(body);
            if (!parsed.success) {
                return Response.json(AccountSettingsV2UpdateResponseSchema.parse({ success: false, error: 'invalid', reason: 'tooLarge' }));
            }
            const currentVersion = current.version;
            if (parsed.data.expectedVersion !== currentVersion) {
                return Response.json(AccountSettingsV2UpdateResponseSchema.parse({
                    success: false, error: 'version-mismatch', currentVersion, currentContent: current.content,
                }));
            }
            const version = currentVersion + 1;
            settingsByAccount.set(accountId, { content: parsed.data.content, version });
            return Response.json(AccountSettingsV2UpdateResponseSchema.parse({ success: true, version }));
        },
    };
}

/** Bridges Metro's call-time require to the real Vitest executor; substitutes no Action logic. */
export async function installRealActionExecutorModuleLoader(): Promise<() => void> {
    const bridge = await loadVitestModuleForNodeRequire(
        new NodeURL('../../../sync/ops/actions/defaultActionExecutor.ts', import.meta.url),
        () => import('@/sync/ops/actions/defaultActionExecutor'),
    );
    return bridge.dispose;
}

/**
 * Real Homes behind a fake network: every Home is a real server profile and every account
 * context, scoped transport and credential reader runs for real. HTTP and native/browser storage
 * are the external boundaries; synthetic credentials are persisted by the real TokenStorage
 * owner. The last Home listed is the focused one.
 */
export async function serveAccountHomes(params: Readonly<{
    homes: readonly HomeSpec[];
    route: (request: ServedHomeRequest) => Response | undefined | Promise<Response | undefined>;
}>) {
    const [{ upsertServerProfileOnly, setActiveServer }, { TokenStorage }, { setRuntimeFetch, resetRuntimeFetch }, { getStorage }] = await Promise.all([
        import('@/sync/domains/server/serverRuntime'),
        import('@/auth/storage/tokenStorage'),
        import('@/utils/system/runtimeFetch'),
        import('@/sync/domains/state/storage'),
    ]);
    const accounts = new Map<string, string>();
    const byOrigin = new Map<string, string>();
    // Store the server's envelope, not a decrypted client Settings projection.
    // An empty new E2EE Account starts at null/version 0; JSON serialization
    // mirrors the actual HTTP baseline (including omitted undefined fields).
    const initialSettings = params.homes.map(home => {
        const emptyEncryptedAccount = home.accountMode === 'e2ee' && home.settings === undefined;
        return [home.key, AccountSettingsV2GetResponseSchema.parse(JSON.parse(JSON.stringify({
            content: emptyEncryptedAccount ? null : { t: 'plain', v: home.settings ?? {} },
            version: emptyEncryptedAccount ? 0 : 1,
        })))] as const;
    });
    // All consumers share the same authenticated Settings HTTP/CAS owner.
    const settingsByHome = new Map(params.homes.map((home, index) => [home.key,
        createAccountSettingsHttpBoundary({ serverUrl: home.serverUrl,
            initialAccounts: [{ accountId: home.accountId, snapshot: initialSettings[index]![1] }] }),
    ]));
    const specsByHome = new Map(params.homes.map(home => [home.key, home]));
    const homes: Record<string, Readonly<{ id: string; serverUrl: string }>> = {};
    const requests: ServedHomeRequest[] = [];
    const credentialWrites: HomeCredentialWriteRollback[] = [];
    async function writeCredentials(key: string, accountId: string) {
        const home = homes[key];
        if (!home) throw new Error(`Unknown served Home: ${key}`);
        const spec = specsByHome.get(key);
        const rollback = await TokenStorage.setCredentialsForServerUrlWithRollback(
            home.serverUrl, { serverId: home.id },
            { ...(spec?.accountId === accountId ? spec.credentials : undefined),
                token: tokenFor(accountId, spec?.accountId === accountId && spec.currentAccount === true) },
        );
        if (!rollback) throw new Error(`Served Home credentials could not be stored: ${key}`);
        credentialWrites.push(rollback);
    }
    // Activation can start readiness immediately. Install the external HTTP
    // boundary before publishing any fixture Home, as app-entry fixtures do.
    const homeFetch = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const target = new URL(String(url));
        if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return Response.json({});
        const home = byOrigin.get(target.origin);
        if (!home) throw new Error(`Request to an unknown Home: ${target.origin}`);
        const authenticatedAccountId = accountOf(init);
        if (target.pathname === '/v1/account/encryption') {
            const spec = specsByHome.get(home);
            return Response.json({ mode: accounts.get(home) === spec?.accountId ? spec?.accountMode ?? 'plain' : 'plain', updatedAt: 0 });
        }
        if (target.pathname === '/v1/account/encryption/currentness') {
            const spec = specsByHome.get(home);
            const mode = accounts.get(home) === spec?.accountId ? spec?.accountMode ?? 'plain' : 'plain';
            if (mode === 'plain') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ version: 0, updatedAt: 0 }));
        }
        const settingsResponse = settingsByHome.get(home)!.handle(url, init);
        if (settingsResponse) return settingsResponse;
        const request: ServedHomeRequest = {
            home,
            method: init?.method ?? 'GET',
            path: target.pathname,
            url: target,
            accountId: authenticatedAccountId,
            headers: new Headers(init?.headers),
            body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
            signal: init?.signal,
        };
        requests.push(request);
        return await params.route(request) ?? Response.json({ error: 'not_found' }, { status: 404 });
    };
    setRuntimeFetch(homeFetch);
    for (const spec of params.homes) {
        const home = await upsertServerProfileOnly({ serverUrl: spec.serverUrl });
        if (spec.serverIdentityId) {
            // Establish the fixture's verified Home before taking credential
            // rollback custody. A later identity-learning read can otherwise
            // migrate those bytes outside the original rollback's exact keys.
            const { setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
            if (!await setServerProfileIdentityForUrl(home.serverUrl, spec.serverIdentityId)) {
                throw new Error(`Served Home identity could not be established: ${spec.key}`);
            }
        }
        homes[spec.key] = { id: home.id, serverUrl: home.serverUrl };
        accounts.set(spec.key, spec.accountId);
        byOrigin.set(new URL(home.serverUrl).origin, spec.key);
        await writeCredentials(spec.key, spec.accountId);
        // Device selection also works in Node/native harnesses without the
        // browser sessionStorage that owns a tab-scoped selection.
        await setActiveServer({ serverId: home.id });
    }
    const focused = params.homes.at(-1)!;
    const focusedScope = { serverId: homes[focused.key]!.id, accountId: focused.accountId };
    getStorage().setState({ settingsScope: focusedScope, profileScope: focusedScope });
    // A focused Home reads the applied Settings projection, not its HTTP baseline.
    // Publish the same fixture response through the real store producer.
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    getStorage().getState().applySettingsForScope(focusedScope, settingsParse(focused.settings ?? {}), 1);
    return {
        homes,
        requests,
        /** Compose another real network boundary without replacing the Home transport. */
        fetch: homeFetch,
        /** Replace the external Account Settings response; the real store remains its admission owner. */
        replaceAccountSettings(key: string, snapshot: Readonly<{
            settings: Readonly<Record<string, unknown>>;
            version: number;
        }>) {
            if (!settingsByHome.has(key)) throw new Error(`Unknown served Home: ${key}`);
            const settings = AccountSettingsV2GetResponseSchema.parse(JSON.parse(JSON.stringify({
                content: { t: 'plain', v: snapshot.settings }, version: snapshot.version,
            })));
            settingsByHome.get(key)!.replaceAccountSettings(accounts.get(key)!, settings);
        },
        /** Mounted content also needs the real applied Home/Account lifetime, beyond saved profiles. */
        async restoreActiveConnection() {
            await import('@/sync/syncEngine');
            const credential = await TokenStorage.getCredentialsForServerUrl(homes[focused.key]!.serverUrl);
            if (!credential) throw new Error('Served Home Account is unavailable');
            const { restoreConnectionToActiveServer, disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
            await restoreConnectionToActiveServer(credential);
            return disconnectActiveServerConnection;
        },
        /** The Home now signs in as another Account (a sign-out and sign-in elsewhere). */
        async switchAccount(key: string, accountId: string) {
            accounts.set(key, accountId);
            await writeCredentials(key, accountId);
        },
        async dispose() {
            try {
                for (const write of [...credentialWrites].reverse()) {
                    if (!await write.rollback()) throw new Error('Served Home credential rollback failed');
                }
            } finally {
                resetRuntimeFetch();
            }
        },
    };
}

/** Adds the real Metro executor bridge only for journeys that invoke the Action front door. */
export async function serveActionHomes(params: Parameters<typeof serveAccountHomes>[0]) {
    const restoreExecutorModuleLoader = await installRealActionExecutorModuleLoader();
    try {
        const home = await serveAccountHomes(params);
        return {
            ...home,
            async dispose() {
                try {
                    await home.dispose();
                } finally {
                    restoreExecutorModuleLoader();
                }
            },
        };
    } catch (error) {
        restoreExecutorModuleLoader();
        throw error;
    }
}
