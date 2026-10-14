import { SERVER_CONFIG } from '@happier-dev/protocol/serverConfig/registry';
import { readServerConfig, readServerConfigRaw } from '@happier-dev/protocol/serverConfig/serverConfigCodec';
import type { AuthEmailSmtpConfig } from './authEmailAdapters';

/** Shared by delivery and the Home settings declaration, including before mail is configured. */
export function resolveAuthEmailSmtpPort(env: NodeJS.ProcessEnv): number {
    return readServerConfig(env, SERVER_CONFIG.HAPPIER_AUTH_EMAIL_SMTP_PORT)
        ?? (readServerConfig(env, SERVER_CONFIG.HAPPIER_AUTH_EMAIL_SMTP_SECURE) ? 465 : 587);
}

export function resolveAuthEmailSmtpConfig(env: NodeJS.ProcessEnv): AuthEmailSmtpConfig | null {
    const host = readServerConfig(env, SERVER_CONFIG.HAPPIER_AUTH_EMAIL_SMTP_HOST);
    // Deployments may use any from address their relay accepts; Home writes validate the address.
    const fromAddress = readServerConfigRaw(env, SERVER_CONFIG.HAPPIER_AUTH_EMAIL_FROM_ADDRESS)?.raw.trim();
    if (!host || !fromAddress) return null;
    return {
        host,
        port: resolveAuthEmailSmtpPort(env),
        secure: readServerConfig(env, SERVER_CONFIG.HAPPIER_AUTH_EMAIL_SMTP_SECURE),
        username: readServerConfig(env, SERVER_CONFIG.HAPPIER_AUTH_EMAIL_SMTP_USERNAME) ?? null,
        password: readServerConfig(env, SERVER_CONFIG.HAPPIER_AUTH_EMAIL_SMTP_PASSWORD) ?? null,
        fromAddress,
        fromName: readServerConfig(env, SERVER_CONFIG.HAPPIER_AUTH_EMAIL_FROM_NAME),
    };
}
