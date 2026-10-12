import { readServerConfig, SERVER_CONFIG } from '@happier-dev/protocol';
import { readStartupHomeEnv } from '@/app/home/settings/startupHomeEnv';

export function resolveRpcForwardTimeoutMs(requestedTimeoutMs?: number | null): number | null {
    if (requestedTimeoutMs !== undefined) return requestedTimeoutMs;
    // Predecessor callers can omit the deadline; only that legacy shape uses
    // the Home default. Explicit caller lifetime is independent of the method.
    const env = readStartupHomeEnv()?.env ?? process.env;
    return readServerConfig(env, SERVER_CONFIG.HAPPIER_RPC_FORWARD_TIMEOUT_MS);
}
