/** The same environment name used by Sentry startup and the Home declaration. */
export function resolveSentryEnvironment(env: NodeJS.ProcessEnv): string {
    const explicit = (env.SENTRY_ENVIRONMENT ?? env.HAPPIER_SENTRY_ENVIRONMENT ?? '').trim();
    if (explicit) return explicit;
    const nodeEnv = (env.NODE_ENV ?? '').trim();
    const flavor = (env.HAPPIER_SERVER_FLAVOR ?? env.HAPPY_SERVER_FLAVOR ?? '').trim();
    return flavor ? `${nodeEnv || 'production'}:${flavor}` : (nodeEnv || 'production');
}
