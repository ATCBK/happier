import { sync } from '@/sync/sync';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { fireAndForget } from '@/utils/system/fireAndForget';
import type { VoiceRoleReadiness } from '@/voice/registry/readiness';

/** Retry observes presence through Sync's existing exact-Account Machine read. */
export function recoverVoiceSettingsReadiness(
    action: VoiceRoleReadiness['recoveryAction'],
    onRecoveryAction?: (action: VoiceRoleReadiness['recoveryAction']) => void,
): void {
    if (action === 'retry') {
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime?.isCurrent()) return;
        fireAndForget(sync.refreshMachines({ serverId: lifetime.scope.serverId }), { tag: 'Voice.settings.retryMachinePresence' });
        return;
    }
    onRecoveryAction?.(action);
}
