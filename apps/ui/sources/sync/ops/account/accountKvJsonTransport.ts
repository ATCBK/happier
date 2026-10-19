import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { kvGet, kvMutate } from '@/sync/api/account/apiKv';
import { decodeAccountStoredJsonContent, encodeAccountStoredJsonContent } from '@/sync/encryption/accountStoredJsonContent';
import { isRawAccountStorageEncryption, resolveAccountStorageContext, type AccountStorageContext } from '@/sync/encryption/accountStorageContext';
import type { ServerFetch } from '@/sync/http/client';

export type AccountKvJsonSnapshot = Readonly<{ value: unknown | null; version: number; tombstone?: true }>;
export type AccountKvJsonCompareAndSetResult = Readonly<{ success: true; version: number }>
    | (AccountKvJsonSnapshot & Readonly<{ success: false }>);
export type AccountKvJsonTransport = Readonly<{
    read: () => Promise<AccountKvJsonSnapshot>;
    compareAndSet: (value: unknown, version: number) => Promise<AccountKvJsonCompareAndSetResult>;
}>;

export class AccountKvScopeRetiredError extends Error {
    readonly code = 'account_kv_scope_retired';
    constructor() {
        super('The captured Account KV scope retired');
        this.name = 'AccountKvScopeRetiredError';
    }
}

export class AccountKvContentUnreadableError extends Error {
    readonly code = 'account_kv_content_unreadable';
    constructor() {
        super('The encrypted Account KV record could not be opened');
        this.name = 'AccountKvContentUnreadableError';
    }
}

/** Domain owners supply record parsing and reconciliation; this owner handles only opaque JSON/CAS. */
export function createAccountKvJsonTransport(params: Readonly<{
    credentials: AuthCredentials;
    key: string;
    request: ServerFetch;
    shouldContinue: () => boolean;
    encryption?: AccountStorageContext['encryption'];
}>): AccountKvJsonTransport {
    const checkCurrent = () => {
        if (!params.shouldContinue()) throw new AccountKvScopeRetiredError();
    };
    const whileCurrent = async <T,>(operation: () => Promise<T>): Promise<T> => {
        checkCurrent();
        try { return await operation(); }
        finally { checkCurrent(); }
    };
    const request: ServerFetch = (path, init, options) => whileCurrent(() => params.request(path, init, options));
    const requestOptions = { request, retry: 'none' as const };
    const decode = async (encoded: string, context: AccountStorageContext): Promise<unknown> => {
        const value = await whileCurrent(() => decodeAccountStoredJsonContent({ encoded, encryption: context.encryption, expectedMode: context.mode }));
        if (context.mode === 'e2ee' && value === null) throw new AccountKvContentUnreadableError();
        return value;
    };
    return {
        async read() {
            checkCurrent();
            const context = await whileCurrent(() => resolveAccountStorageContext(params.credentials, { ...requestOptions,
                ...(params.encryption !== undefined ? { encryption: params.encryption } : {}) }));
            checkCurrent();
            const item = await kvGet(params.credentials, params.key, requestOptions);
            checkCurrent();
            if (!item) return { value: null, version: -1 };
            const value = await decode(item.value, context);
            checkCurrent();
            return { value, version: item.version };
        },
        async compareAndSet(value, version) {
            checkCurrent();
            const context = await whileCurrent(() => resolveAccountStorageContext(params.credentials, { ...requestOptions,
                ...(params.encryption !== undefined ? { encryption: params.encryption } : {}) }));
            checkCurrent();
            const encoded = await whileCurrent(() => encodeAccountStoredJsonContent({
                mode: context.mode,
                value,
                encryption: isRawAccountStorageEncryption(context.encryption) ? context.encryption : null,
            }));
            checkCurrent();
            // Currentness was checked immediately before issuance. Preserve an
            // acknowledged write's receipt even if its captured scope then retires.
            const result = await kvMutate(params.credentials, [{ key: params.key, value: encoded, version }], {
                ...requestOptions, request: params.request,
            });
            if (result.success) {
                const stored = result.results.find(item => item.key === params.key);
                if (!stored) throw new Error('KV mutation omitted its result');
                return { success: true, version: stored.version };
            }
            checkCurrent();
            const conflict = result.errors.find(item => item.key === params.key);
            if (!conflict) throw new Error('KV mutation omitted its conflict');
            const remoteValue = conflict.value === null ? null : await decode(conflict.value, context);
            checkCurrent();
            return { success: false, value: remoteValue, version: conflict.version,
                ...(conflict.value === null ? { tombstone: true as const } : {}) };
        },
    };
}
