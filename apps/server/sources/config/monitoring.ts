import { readServerConfig } from '@happier-dev/protocol/serverConfig/serverConfigCodec';
import { SERVER_CONFIG } from '@happier-dev/protocol/serverConfig/registry';

type EnvLike = Record<string, string | undefined>;

/** Metrics server settings; types, defaults and bounds are declared in the server configuration registry. */
export function readMetricsServerConfigFromEnv(env: EnvLike): Readonly<{
    enabled: boolean;
    port: number;
}> {
    return {
        enabled: readServerConfig(env, SERVER_CONFIG.METRICS_ENABLED),
        port: readServerConfig(env, SERVER_CONFIG.METRICS_PORT),
    };
}
