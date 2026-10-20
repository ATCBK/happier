import type { ServerFlavor } from './backends';

export type DbProvider = 'postgres' | 'pglite' | 'sqlite' | 'mysql';
export type DbSqlDialect = Exclude<DbProvider, 'pglite'>;

/** SQL compatibility is distinct from the backend's connection and shutdown lifecycle. */
export function resolveDbSqlDialect(provider: DbProvider): DbSqlDialect {
    return provider === 'pglite' ? 'postgres' : provider;
}

export function resolveDefaultDbProvider(flavor: ServerFlavor): DbProvider {
    return flavor === 'light' ? 'sqlite' : 'postgres';
}

export function parseDbProvider(rawValue: unknown): DbProvider | null {
    const raw = rawValue?.toString().trim().toLowerCase();
    if (raw === 'postgresql' || raw === 'postgres') return 'postgres';
    if (raw === 'pglite' || raw === 'sqlite' || raw === 'mysql') return raw;
    return null;
}

export function getDbProviderFromEnv(env: NodeJS.ProcessEnv, fallback: DbProvider): DbProvider {
    return parseDbProvider(env.HAPPIER_DB_PROVIDER ?? env.HAPPY_DB_PROVIDER) ?? fallback;
}

export function requireDbProviderFromEnv(env: NodeJS.ProcessEnv, fallback: DbProvider): DbProvider {
    const raw = env.HAPPIER_DB_PROVIDER ?? env.HAPPY_DB_PROVIDER;
    if (raw === undefined || !raw.toString().trim()) return fallback;
    const provider = parseDbProvider(raw);
    if (provider) return provider;
    throw new Error(`Unsupported HAPPIER_DB_PROVIDER/HAPPY_DB_PROVIDER: ${raw}. Supported: postgres|mysql|pglite|sqlite`);
}
