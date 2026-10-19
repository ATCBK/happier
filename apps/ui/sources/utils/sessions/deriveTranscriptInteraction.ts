import type { Session } from '@/sync/domains/state/storageTypes';
import { isPendingRequestAnswerableV1 } from '@happier-dev/protocol/sessions/personal/attention';
import { isSessionActionConfirmationRequest } from '@happier-dev/protocol/sessions/metadata/sessionActionConfirmationsV1';

/** Native prompts need a live runtime; host Action decisions retain their approval grant. */
export function isTranscriptPendingRequestAnswerable(
    session: Session,
    request: Readonly<{ kind: 'permission' | 'user_action'; source?: string }>,
): boolean {
    const interaction = deriveTranscriptInteractionFromSession(session);
    if (isSessionActionConfirmationRequest(request)) return interaction.canApproveActions === true;
    if (session.active !== true) return false;
    return isPendingRequestAnswerableV1(request, {
        canSubmitAgentInput: interaction.canSendMessages,
        canApprovePermissions: interaction.canApprovePermissions,
    });
}

/**
 * Why this presentation cannot answer a prompt. `openSession` is the embedded read-only view: the
 * prompt is answerable, but in the full Session rather than here.
 */
export type TranscriptPermissionDisabledReason = 'public' | 'readOnly' | 'notGranted' | 'inactive' | 'openSession';

export type TranscriptInteraction = Readonly<{
    canSendMessages: boolean;
    canApprovePermissions: boolean;
    /** Artifact decisions retain the access grant when the agent process is inactive. */
    canApproveActions?: boolean;
    /** Action grant for creating a fork from this transcript surface. Missing grants fail closed. */
    canFork?: boolean;
    /** Grant for opening session/workspace file surfaces. Missing grants fail closed. */
    canOpenFiles?: boolean;
    /** Grant for resolving and opening session media previews. Missing grants fail closed. */
    canPreviewMedia?: boolean;
    permissionDisabledReason?: TranscriptPermissionDisabledReason;
}>;

/**
 * Known write denial for one exact Session — the opposite question from
 * {@link deriveTranscriptInteraction}'s `canSendMessages`.
 *
 * `canSendMessages` fails closed, which is correct before mutating: an
 * unloaded Session, an absent access projection or an offline Home all read as
 * "cannot send". That answer must not decide whether an affordance is offered,
 * because it would take composing away from a writer whose Session simply has
 * not loaded yet. This returns `true` only when the exact Session's own access
 * projection states the capability is denied; everything else stays enabled
 * with the server as the authority.
 */
export function isSessionWriteKnownDenied(
    session: Readonly<{ access?: Session['access'] }> | null | undefined,
): boolean {
    return session?.access?.capabilities.submitAgentInput === false;
}

export function deriveTranscriptInteractionFromSession(
    session: Readonly<{
        access?: Session['access'];
        active?: boolean | null | undefined;
        presence?: 'online' | number | null | undefined;
    }>,
): TranscriptInteraction {
    // Treat `session.active` as the source of truth. When `active` is missing/unknown, be conservative
    // and treat the session as inactive for interaction surfaces like permission approvals.
    const isSessionActive = session.active === true;

    return deriveTranscriptInteraction({
        kind: 'session',
        access: session.access,
        isSessionActive,
    });
}

export function deriveTranscriptInteraction(
    input:
        | Readonly<{
              kind: 'session';
              access?: Session['access'];
              isSessionActive?: boolean | null | undefined;
          }>
        | Readonly<{
              kind: 'public';
          }>,
): TranscriptInteraction {
    if (input.kind === 'public') {
        return {
            canSendMessages: false,
            canApprovePermissions: false,
            canApproveActions: false,
            canFork: false,
            canOpenFiles: false,
            canPreviewMedia: false,
            permissionDisabledReason: 'public',
        };
    }

    const canSendMessages = input.access?.capabilities.submitAgentInput === true;
    const baseCanApprovePermissions = input.access?.capabilities.approveRuntimePermissions === true;
    const isSessionActive = input.isSessionActive !== false;
    const canApprovePermissions = baseCanApprovePermissions && isSessionActive;
    const permissionDisabledReason: TranscriptInteraction['permissionDisabledReason'] = !isSessionActive
        ? 'inactive'
        : canApprovePermissions
            ? undefined
            : input.access?.level === 'view'
                ? 'readOnly'
                : 'notGranted';

    return {
        canSendMessages,
        canApprovePermissions,
        canApproveActions: baseCanApprovePermissions,
        canFork: canSendMessages,
        canOpenFiles: input.access?.capabilities.readTranscript === true,
        canPreviewMedia: input.access?.capabilities.readTranscript === true,
        permissionDisabledReason,
    };
}
