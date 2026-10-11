import type { AgentInputStatusBadge } from '@/components/sessions/agentInput/agentInputContracts';
import { buildRequesterDisclosureStatusBadge, type RequesterDisclosureModel } from '@/components/machines/managed/managedComposerBadges';

type NewSessionLaunchStatusParams = Readonly<{
    isCreating: boolean;
    disabledReason?: string | null;
    requesterDisclosure?: RequesterDisclosureModel;
    translate: (key: 'newSession.startingSession') => string;
}>;

/**
 * The launch's one cause, said on the composer's status line above the card (left), the same line a
 * session uses for its status (0.2 anatomy). `blocked` needs the person; `starting` needs nothing.
 */
export type NewSessionLaunchStatusLine = Readonly<{ kind: 'blocked' | 'starting'; text: string }>;

export type NewSessionLaunchStatus = Readonly<{
    line: NewSessionLaunchStatusLine | null;
    /** Right-aligned badges keep only facts with their own detail (the requester disclosure). */
    badges: ReadonlyArray<AgentInputStatusBadge>;
}>;

export function buildNewSessionLaunchStatus(params: NewSessionLaunchStatusParams): NewSessionLaunchStatus {
    const badges: ReadonlyArray<AgentInputStatusBadge> = params.requesterDisclosure
        ? [buildRequesterDisclosureStatusBadge(params.requesterDisclosure)] : [];
    if (params.isCreating) {
        return { line: { kind: 'starting', text: params.translate('newSession.startingSession') }, badges };
    }
    return { line: params.disabledReason ? { kind: 'blocked', text: params.disabledReason } : null, badges };
}
