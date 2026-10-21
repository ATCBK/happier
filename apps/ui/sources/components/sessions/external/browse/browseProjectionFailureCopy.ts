import type { MachineContributionRegistryProjectionFailureReason } from '@/sync/ops/machineContributionRegistryProjection';
import { t } from '@/text';

export type BrowseProjectionFailureCopy = Readonly<{
    title: string;
    reason: string;
    /** The typed projection reason, for the card's collapsed Details only. */
    diagnosticCode: string | null;
}>;

/**
 * What to say when a Machine's integration projection could not be read. The typed reason picks the
 * next step the person can take: wait for the Machine's Happier service, update it, regain access, or
 * retry a response this device could not read. A failure is never worded as "nothing available".
 */
export function resolveBrowseProjectionFailureCopy(input: Readonly<{
    phase: 'unsupported' | 'error';
    failureReason?: MachineContributionRegistryProjectionFailureReason;
    /** The Machine's name, or null for "this machine". */
    machineName: string | null;
}>): BrowseProjectionFailureCopy {
    const machine = input.machineName ?? t('externalSessions.browseThisMachine');
    const diagnosticCode = input.failureReason ?? null;
    if (input.phase === 'unsupported') {
        return {
            title: t('externalSessions.browseUpdateNeededTitle', { machine }),
            reason: t('externalSessions.browseUpdateNeededBody'),
            diagnosticCode: 'unsupported',
        };
    }
    switch (input.failureReason) {
        case 'update-required':
        case 'not-supported':
            return {
                title: t('externalSessions.browseUpdateNeededTitle', { machine }),
                reason: t('externalSessions.browseUpdateNeededBody'),
                diagnosticCode,
            };
        case 'access-denied':
        case 'authentication-required':
        case 'authentication-unavailable':
            return {
                title: t('externalSessions.browseAccessRefusedTitle', { machine }),
                reason: t('externalSessions.browseAccessRefusedBody'),
                diagnosticCode,
            };
        case 'invalid-response':
        case 'encryption-unavailable':
            return {
                title: t('externalSessions.browseUnreadableTitle', { machine }),
                reason: t('externalSessions.browseUnreadableBody'),
                diagnosticCode,
            };
        default:
            return {
                title: t('externalSessions.browseCantReachTitle', { machine }),
                reason: t('externalSessions.browseCantReachBody'),
                diagnosticCode,
            };
    }
}
