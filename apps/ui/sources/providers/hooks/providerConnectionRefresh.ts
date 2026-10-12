import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

export type ProviderConnectionRefreshScope = 'account' | 'machine';
export type ProviderConnectionReadTarget = Readonly<{ machineId: string | null; serverId: string | null }>;

type ConnectionReader = Readonly<{
    targets: readonly ProviderConnectionReadTarget[];
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    read: (targets: readonly ProviderConnectionReadTarget[]) => Promise<unknown>;
}>;

// Only mounted, demanded readers participate. Each reader retains custody of
// its data, errors, cancellation and Account lifetime.
const activeReaders = new Set<ConnectionReader>();

export function registerProviderConnectionReader(reader: ConnectionReader): () => void {
    activeReaders.add(reader);
    return () => { activeReaders.delete(reader); };
}

export function refreshProviderConnectionReaders(input: ProviderConnectionReadTarget & Readonly<{
    scope: ProviderConnectionRefreshScope;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    ownRead: ConnectionReader['read'];
}>): void {
    // Invoke private reads, never peer refreshes, so this cannot recurse or
    // hold a successful mutation open while supporting panes are reading.
    for (const reader of activeReaders) {
        if (reader.read === input.ownRead || reader.accountLifetime !== input.accountLifetime) continue;
        const targets = reader.targets.filter(target => target.serverId === input.serverId
            && (input.scope === 'account' || target.machineId === input.machineId));
        if (targets.length > 0) void reader.read(targets).catch(() => undefined);
    }
}
