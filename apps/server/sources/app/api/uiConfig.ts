import { readServerConfig } from '@happier-dev/protocol/serverConfig/serverConfigCodec';
import { SERVER_CONFIG } from '@happier-dev/protocol/serverConfig/registry';

export type UiConfig = {
    dir: string | null;
    deploymentId?: string | null;
    /**
     * UI mount prefix for route registration (no trailing slash).
     * - "/" means "mounted at root"
     * - "/ui" means "mounted under /ui"
     */
    prefix: string;
    mountRoot: boolean;
    /**
     * When true, server startup should fail closed if the UI bundle is missing/incomplete.
     * This is intended for local stack orchestration where "serve UI" is an explicit capability.
     */
    required: boolean;
};

export function resolveUiConfig(env: NodeJS.ProcessEnv = process.env): UiConfig {
    const dir = readServerConfig(env, SERVER_CONFIG.HAPPIER_SERVER_UI_DIR) ?? null;

    const prefixNormalized = readServerConfig(env, SERVER_CONFIG.HAPPIER_SERVER_UI_PREFIX);
    const mountRoot = prefixNormalized === '/' || prefixNormalized === '';
    const prefix = mountRoot
        ? '/'
        : prefixNormalized.endsWith('/')
            ? prefixNormalized.slice(0, -1)
            : prefixNormalized;

    const required = readServerConfig(env, SERVER_CONFIG.HAPPIER_SERVER_UI_REQUIRED);
    const deploymentIdRaw = readServerConfig(env, SERVER_CONFIG.HAPPIER_SERVER_UI_DEPLOYMENT_ID) ?? '';
    const deploymentId = /^[A-Za-z0-9_-]{16,128}$/.test(deploymentIdRaw)
        ? deploymentIdRaw
        : null;

    return { dir, prefix, mountRoot, required, deploymentId };
}
