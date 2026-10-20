import type { DbProvider } from '../sources/config/databaseProvider';

/** Keep direct maintenance connections local to migrations; runtime stays pooled. */
export function resolveMigrationEnv(env: NodeJS.ProcessEnv, provider: DbProvider): NodeJS.ProcessEnv {
    const directUrl = provider === 'postgres' ? env.DIRECT_URL?.trim() : undefined;
    return { ...env, ...(directUrl ? { DATABASE_URL: directUrl } : {}) };
}
