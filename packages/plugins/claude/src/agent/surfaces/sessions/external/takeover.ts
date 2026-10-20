import type {
    AgentExternalSessionTakeoverContribution,
    AgentExternalSessionTakeoverLaunchPlan,
    AgentExternalSessionTakeoverResolveLaunchRequest,
} from '@happier-dev/plugin-sdk/sessions/external';

import { readClaudeProviderIdentityValue } from '../../../../protocol/providerIdentity.js';
import { resolveClaudeConfigDirEnvOverlay } from '../../../environment.js';
import { canonicalizeClaudeConfigDir, resolveCanonicalConfiguredClaudeConfigDir } from './source.js';
type ClaudeExternalSessionTakeoverIdentity =
    Pick<
        AgentExternalSessionTakeoverResolveLaunchRequest,
        'source' | 'remoteSessionId' | 'linkData' | 'linkedDirectory'
    >;

function readNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed || null;
}

export function resolveClaudeExternalSessionTakeoverPlan(
    identity: ClaudeExternalSessionTakeoverIdentity,
): AgentExternalSessionTakeoverLaunchPlan | null {
    const env = process.env;
    const remoteSessionId = readClaudeProviderIdentityValue(identity.remoteSessionId);
    const configDir = readNonEmptyString(identity.source.configDir);
    const sourceProjectId = readNonEmptyString(identity.source.projectId);
    const linkedProjectId = readNonEmptyString(identity.linkData.projectId);
    if (
        identity.source.kind !== 'claudeConfig'
        || !remoteSessionId
        || !configDir
        || !sourceProjectId
        || sourceProjectId !== linkedProjectId
    ) {
        return null;
    }

    return Object.freeze({
        // Source normalization records a transcript root, not the presence of
        // the native auth override. Preserve the current environment for its
        // own store and retain pinning for a different linked store.
        environmentVariables: Object.freeze(
            canonicalizeClaudeConfigDir(configDir, env) === resolveCanonicalConfiguredClaudeConfigDir({ env })
                ? resolveClaudeConfigDirEnvOverlay(env)
                : { CLAUDE_CONFIG_DIR: configDir },
        ),
        applyConnectedAccountDefaults: true,
    });
}

export const claudeExternalSessionTakeoverContribution:
    AgentExternalSessionTakeoverContribution = Object.freeze({
        resolveLaunch(request) {
            if (request.signal.aborted) {
                return { ok: false, code: 'cancelled' };
            }
            if (Date.now() >= request.deadlineAtMs) {
                return { ok: false, code: 'timeout', retryable: true };
            }
            if (!readNonEmptyString(request.linkedDirectory)) {
                return { ok: false, code: 'unavailable' };
            }
            const plan = resolveClaudeExternalSessionTakeoverPlan(request);
            return plan
                ? { ok: true, value: plan }
                : { ok: false, code: 'source_invalid' };
        },
    });
