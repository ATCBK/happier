import type { TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';

export function deriveReadOnlyTranscriptInteraction(
    interaction: TranscriptInteraction,
    readOnly: boolean,
): TranscriptInteraction {
    if (!readOnly) return interaction;
    return {
        ...interaction,
        canSendMessages: false,
        canApprovePermissions: false,
        canApproveActions: false,
        canFork: false,
        permissionDisabledReason: 'readOnly',
    };
}
