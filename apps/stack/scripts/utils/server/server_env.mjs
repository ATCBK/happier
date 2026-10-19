import { resolveServerUiEnv } from './ui_env.mjs';

function resolveStackServerLogLevel({ baseEnv }) {
  const stackLevel = String(baseEnv.HAPPIER_STACK_SERVER_LOG_LEVEL ?? '').trim();
  if (stackLevel) return stackLevel;

  const serverLevel = String(baseEnv.HAPPIER_SERVER_LOG_LEVEL ?? '').trim();
  if (serverLevel) return serverLevel;

  const inheritedLevel = String(baseEnv.HAPPIER_LOG_LEVEL ?? baseEnv.LOG_LEVEL ?? '').trim();
  if (inheritedLevel) return null;

  return 'warn';
}

export function buildServerRuntimeEnv({
  baseEnv,
  serverPort,
  canonicalServerUrl = '',
  publicServerUrl,
  serveUi = false,
  uiRequired = false,
  uiBuildDir = '',
  uiBuildDirExists = false,
  uiPrefix = '/',
}) {
  // Canonical identity is never derived from the public ingress URL: that value is inferred per start
  // (Tailscale/relay/LAN) and would rotate the server's signed auth audience. Operator configuration
  // wins, then the stack-owned canonical origin resolved by the stack URL owner, then the bounded
  // explicit legacy public URL, then the local listener origin.
  const operatorCanonicalServerUrl = String(baseEnv.HAPPIER_CANONICAL_SERVER_URL || '').trim();
  const stackCanonicalServerUrl = String(canonicalServerUrl || '').trim();
  const explicitLegacyPublicServerUrl = String(
    baseEnv.HAPPIER_PUBLIC_SERVER_URL_INFERRED === '1'
      ? ''
      : baseEnv.HAPPIER_PUBLIC_SERVER_URL || '',
  ).trim();
  const stableCanonicalServerUrl = operatorCanonicalServerUrl
    || stackCanonicalServerUrl
    || explicitLegacyPublicServerUrl
    || `http://localhost:${serverPort}`;
  const nextEnv = {
    ...baseEnv,
    PORT: String(serverPort),
    HAPPIER_CANONICAL_SERVER_URL: stableCanonicalServerUrl,
    HAPPIER_PUBLIC_SERVER_URL: publicServerUrl,
    PUBLIC_URL: publicServerUrl,
    METRICS_ENABLED: baseEnv.METRICS_ENABLED ?? 'false',
    ...(!String(baseEnv.HAPPIER_WEBAPP_URL ?? '').trim() && serveUi
      ? { HAPPIER_WEBAPP_URL: publicServerUrl }
      : {}),
  };
  const serverLogLevel = resolveStackServerLogLevel({ baseEnv });
  if (serverLogLevel) {
    nextEnv.HAPPIER_SERVER_LOG_LEVEL = serverLogLevel;
  }

  if (serveUi) {
    nextEnv.HAPPIER_SERVER_UI_REQUIRED = uiRequired ? '1' : '0';
  }

  return {
    ...nextEnv,
    ...resolveServerUiEnv({
      serveUi,
      uiBuildDir,
      uiPrefix,
      uiBuildDirExists,
    }),
  };
}
