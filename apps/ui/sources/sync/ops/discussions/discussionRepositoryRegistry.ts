import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerAccountScopesEqual, serverAccountScopedResourceKey } from '@/sync/domains/scope/serverAccountScope';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { isEmbedWindowContext } from '@/embed/isEmbedWindowContext';

import {
    createDiscussionRepository,
    type DiscussionRepository,
    type DiscussionRepositoryClient,
} from './discussionRepository';

type RegisteredRepository = {
    repository: DiscussionRepository;
    retirement?: Readonly<{ dispose(): void }>;
};

const repositories = new Map<string, RegisteredRepository>();
const registrationListeners = new Map<string, Set<() => void>>();

function repositoryKey(scope: ServerAccountScope, address: Readonly<{ serverId: string }>): string {
    if (scope.serverId !== address.serverId) {
        throw new Error('Discussion repository requires the exact Home');
    }
    return serverAccountScopedResourceKey(scope, 'discussions');
}

/**
 * Canonical in-memory owner for one Account + Home Discussion projection.
 * List and detail surfaces share this instance so navigation cannot fork pagination,
 * optimistic identities, approval state, or outcome-unknown reconciliation.
 */
export function getDiscussionRepository(options: Readonly<{
    scope: ServerAccountScope;
    address: Readonly<{ serverId: string }>;
    client: DiscussionRepositoryClient;
    accountLifetime?: ServerAccountScopeLifetime | null;
}>): DiscussionRepository {
    if (options.accountLifetime && !areServerAccountScopesEqual(options.accountLifetime.scope, options.scope)) {
        throw new Error('Session Discussion repository Account lifetime must match its exact Account scope');
    }
    const key = repositoryKey(options.scope, options.address);
    const existing = repositories.get(key);
    if (existing) {
        existing.repository.setClient(options.client);
        if (!existing.retirement && options.accountLifetime && isEmbedWindowContext()) {
            existing.retirement = options.accountLifetime.onRetire(() => retireRegisteredRepository(key));
        }
        return existing.repository;
    }
    const repository = createDiscussionRepository({ scope: options.scope, address: options.address, client: options.client });
    const registered: RegisteredRepository = { repository };
    repositories.set(key, registered);
    for (const listener of [...registrationListeners.get(key) ?? []]) listener();
    // Native/app credential bindings belong to individual mounted surfaces:
    // their cleanup is not Account retirement for this shared repository.
    // Embedded admission, in contrast, is a genuine runtime-owned lifetime.
    if (isEmbedWindowContext() && options.accountLifetime) {
        registered.retirement = options.accountLifetime.onRetire(() => retireRegisteredRepository(key));
    } else if (!isEmbedWindowContext()) {
        registered.retirement = { dispose: subscribeHomeCredentialChange(event => {
            if (areServerProfileIdentifiersEquivalent(event.serverId, options.scope.serverId)) {
                retireRegisteredRepository(key);
            }
        }) };
    }
    return repository;
}

function retireRegisteredRepository(key: string): void {
    const existing = repositories.get(key);
    if (!existing) return;
    repositories.delete(key);
    for (const listener of [...registrationListeners.get(key) ?? []]) listener();
    existing.retirement?.dispose();
    existing.repository.clear();
}

/** Chrome reads the same repository as list/detail bodies without creating a client or mounting a watcher. */
export function readRegisteredDiscussionRepository(scope: ServerAccountScope, address: Readonly<{ serverId: string }>): DiscussionRepository | null {
    return repositories.get(repositoryKey(scope, address))?.repository ?? null;
}

/** Follow both an existing projection and a body that registers it after its chrome mounted. */
export function subscribeRegisteredDiscussionRepository(scope: ServerAccountScope, address: Readonly<{ serverId: string }>, listener: () => void): () => void {
    const key = repositoryKey(scope, address);
    let unsubscribe: (() => void) | undefined;
    const bind = () => {
        unsubscribe?.();
        unsubscribe = repositories.get(key)?.repository.subscribe(listener);
        listener();
    };
    const listeners = registrationListeners.get(key) ?? new Set<() => void>();
    listeners.add(bind);
    registrationListeners.set(key, listeners);
    unsubscribe = repositories.get(key)?.repository.subscribe(listener);
    return () => {
        unsubscribe?.();
        listeners.delete(bind);
        if (!listeners.size) registrationListeners.delete(key);
    };
}

/** Explicit scope retirement hook for Account removal/sign-out. */
export function retireDiscussionRepository(options: Readonly<{
    scope: ServerAccountScope;
    address: Readonly<{ serverId: string }>;
}>): void {
    const key = repositoryKey(options.scope, options.address);
    retireRegisteredRepository(key);
}

export function clearDiscussionRepositoryRegistryForTests(): void {
    for (const key of [...repositories.keys()]) retireRegisteredRepository(key);
}
