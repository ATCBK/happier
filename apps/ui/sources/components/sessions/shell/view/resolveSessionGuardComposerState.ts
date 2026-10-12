import type { SessionListGuardState } from '@/sync/domains/session/listing/sessionListRenderable';
import { t } from '@/text';

/**
 * What the composer says while the machine's guard is about to stop this Session, after it stopped it,
 * and while the next message wakes it (plan 50 GRD-7/10/23, lab `rg` G3-5…7, G3w). The guard decides;
 * this only words the Session's own guard presentation for the composer's status row and placeholder.
 */
export type SessionGuardComposerState =
    | Readonly<{ kind: 'warning'; text: string; countdownTo: number; action: 'keep_running' }>
    | Readonly<{ kind: 'stopped'; text: string; placeholder: string }>
    | Readonly<{ kind: 'waking'; text: string }>;

export function resolveSessionGuardComposerState(input: Readonly<{
    guard: SessionListGuardState | null;
    sessionActive: boolean;
    /** The existing wake on the next message is under way (`sessionStatus.state === 'resuming'`). */
    resuming: boolean;
    nowMs: number;
}>): SessionGuardComposerState | null {
    const guard = input.guard;
    if (!guard) return null;
    if (guard.kind === 'stopping') {
        // A warning that already ran out is the guard's to settle; the composer stops counting.
        if (!input.sessionActive || guard.stopAt <= input.nowMs) return null;
        return { kind: 'warning', text: t('machineGuard.session.stoppingIn'), countdownTo: guard.stopAt, action: 'keep_running' };
    }
    if (input.resuming) return { kind: 'waking', text: t('machineGuard.session.waking') };
    if (input.sessionActive) return null;
    return {
        kind: 'stopped',
        text: guard.rule === 'ceiling' ? t('machineGuard.session.stoppedAtCeiling') : t('machineGuard.session.stoppedToFreeMemory'),
        placeholder: t('machineGuard.session.wakePlaceholder'),
    };
}
