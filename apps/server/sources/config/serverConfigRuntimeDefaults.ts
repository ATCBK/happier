import { readServerConfig, readServerConfigRaw, type ServerConfigEnv } from '@happier-dev/protocol/serverConfig/serverConfigCodec';
import { type ServerConfigEntry, type ServerConfigValue } from '@happier-dev/protocol/serverConfig/serverConfigEntry';

import { resolveDefaultAuthOffboardingEnabled } from '@/app/auth/authPolicy';
import { resolveAuthEmailSmtpPort } from '@/app/auth/email/authEmailSmtpConfig';
import { resolveGitHubAuthRestrictionsFromEnv, shouldStoreGithubAccessToken } from '@/app/auth/providers/github/restrictions';
import { resolveSentryEnvironment } from '@/app/monitoring/sentryEnvironment';
import { resolveLightDataDir, resolveLightDatabaseDir, resolveLightFilesDir, resolveLightPublicUrl } from '@/flavors/light/env';
import { getFilesBackendFromEnv, getSocketAdapterFromEnv, resolveDefaultFilesBackend, resolveDefaultSocketAdapter, resolveServerFlavorFromEnv, shouldApplyLightDefaultEnv } from './backends';
import { getDbProviderFromEnv, resolveDefaultDbProvider } from './databaseProvider';
import { readDatabaseTransactionConfigFromEnv } from './databaseTransactions';

/**
 * Only the registry defaults whose startup/read owner depends on other runtime facts.
 * Clear this entry's own env names so the existing owner answers the fallback, not an override.
 * No rule for flavour, SMTP, database tuning or authentication is duplicated here.
 */
export function resolveServerConfigRuntimeDefault(entry: ServerConfigEntry, env: ServerConfigEnv): ServerConfigValue | undefined {
    if (!readServerConfigRaw(env, entry)) return readServerConfigRuntimeValue(entry, env);
    const withoutValue: NodeJS.ProcessEnv = { ...env };
    for (const key of [entry.key, ...(entry.aliases ?? [])]) delete withoutValue[key];
    return readServerConfigRuntimeValue(entry, withoutValue);
}

/** Projection adapter to the runtime readers, including their malformed-value fallback. */
export function readServerConfigRuntimeValue(entry: ServerConfigEntry, env: ServerConfigEnv): ServerConfigValue | undefined {
    const flavor = resolveServerFlavorFromEnv(env, 'full');
    switch (entry.key) {
        case 'HAPPIER_FILES_BACKEND':
            return getFilesBackendFromEnv(env, resolveDefaultFilesBackend(flavor));
        case 'HAPPIER_SOCKET_ADAPTER':
            return getSocketAdapterFromEnv(env, resolveDefaultSocketAdapter(flavor));
        case 'HAPPIER_DB_PROVIDER':
            return getDbProviderFromEnv(env, resolveDefaultDbProvider(flavor));
        case 'HAPPIER_DB_TX_MAX_RETRIES':
        case 'HAPPIER_DB_TX_RETRY_BASE_DELAY_MS':
        case 'HAPPIER_DB_TX_RETRY_MAX_DELAY_MS':
        case 'HAPPIER_DB_TX_RETRY_JITTER_FACTOR':
        case 'HAPPIER_DB_TX_TIMEOUT_MS':
        case 'HAPPIER_DB_TX_MAX_WAIT_MS':
        case 'HAPPIER_DB_TX_TOTAL_RETRY_BUDGET_MS': {
            const config = readDatabaseTransactionConfigFromEnv(env, getDbProviderFromEnv(env, resolveDefaultDbProvider(flavor)));
            const fields = {
                HAPPIER_DB_TX_MAX_RETRIES: 'maxRetries',
                HAPPIER_DB_TX_RETRY_BASE_DELAY_MS: 'retryBaseDelayMs',
                HAPPIER_DB_TX_RETRY_MAX_DELAY_MS: 'retryMaxDelayMs',
                HAPPIER_DB_TX_RETRY_JITTER_FACTOR: 'retryJitterFactor',
                HAPPIER_DB_TX_TIMEOUT_MS: 'timeoutMs',
                HAPPIER_DB_TX_MAX_WAIT_MS: 'maxWaitMs',
                HAPPIER_DB_TX_TOTAL_RETRY_BUDGET_MS: 'totalRetryBudgetMs',
            } as const;
            return config[fields[entry.key]];
        }
        case 'HAPPIER_AUTH_EMAIL_SMTP_PORT':
            return resolveAuthEmailSmtpPort(env);
        case 'AUTH_GITHUB_ORG_MEMBERSHIP_SOURCE':
            return resolveGitHubAuthRestrictionsFromEnv(env).orgMembershipSource;
        case 'GITHUB_STORE_ACCESS_TOKEN':
            return shouldStoreGithubAccessToken({ env });
        case 'AUTH_OFFBOARDING_ENABLED':
            return readServerConfig(env, entry) ?? resolveDefaultAuthOffboardingEnabled(env);
        case 'SENTRY_ENVIRONMENT':
            return resolveSentryEnvironment(env);
        case 'HAPPIER_SERVER_LIGHT_DATA_DIR':
            return shouldApplyLightDefaultEnv(env, flavor) ? resolveLightDataDir(env) : readServerConfig(env, entry);
        case 'HAPPIER_SERVER_LIGHT_DB_DIR':
            return shouldApplyLightDefaultEnv(env, flavor) ? resolveLightDatabaseDir(env, resolveLightDataDir(env)) : readServerConfig(env, entry);
        case 'HAPPIER_SERVER_LIGHT_FILES_DIR':
            return shouldApplyLightDefaultEnv(env, flavor) ? resolveLightFilesDir(env, resolveLightDataDir(env)) : readServerConfig(env, entry);
        case 'PUBLIC_URL':
            return shouldApplyLightDefaultEnv(env, flavor) ? resolveLightPublicUrl(env) : readServerConfig(env, entry);
        default:
            return readServerConfig(env, entry);
    }
}
