import type { DiscussionParticipantsListResponseV1 } from '@happier-dev/protocol/discussions/participants';
import type { ExecutableParticipantSelectionV1 } from '@happier-dev/protocol/discussions/executableParticipants';
import type { ExecutableParticipantPickerOption } from '@/components/sessions/authoring/executableParticipantPicker';
import type { SessionAccessCandidateRowModel } from '@/components/sessions/access/sessionAccessEditorTypes';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { projectDiscussionInviteCandidatesV1 } from '@happier-dev/protocol/discussions/actions';
import type { SessionEffectiveAccessV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import type { SessionReadinessRepairV1, SessionReadinessV1 } from '@happier-dev/protocol/sessions/control/sessionReadinessV1';

export type DiscussionInviteCandidate =
    | Readonly<{
        kind: 'account'; key: string;
        participant: Readonly<{ kind: 'account'; accountId: string }>;
        principal: SessionAccessCandidateRowModel['principal'];
        availability: SessionAccessCandidateRowModel['addition'];
    }>
    | Readonly<{
        kind: 'session'; key: string;
        selection: Extract<ExecutableParticipantSelectionV1, { kind: 'session' }>;
        label: string | null;
        /** Whether the existing Session title owner can read this exact Home's title. */
        titleReadable: boolean;
        /** Agent and Machine/workspace identity from the shared Session display owner. */
        contextLabel?: string | null;
        /** The Agent that byline names, so the row leads with its own mark. */
        agentId?: string | null;
        /** The list owner's public recency remains available when private identity is locked. */
        lastActivityAt?: number | null;
        /** Invitation is not a claim that this Session is currently able to answer. */
        availability: Readonly<{ kind: 'existing_session' }>;
        readiness: SessionReadinessV1 | null;
        repair: SessionReadinessRepairV1 | null;
    }>
    | Readonly<{
        kind: 'model'; key: string;
        selection: Extract<ExecutableParticipantSelectionV1, { kind: 'model' }>;
        label: string;
        /** The ordinary authoring/readiness owner supplies this exact setup observation. */
        availability: ExecutableParticipantPickerOption['readiness'];
        readiness: ExecutableParticipantPickerOption['readiness'];
        repair: ExecutableParticipantPickerOption['repair'];
    }>;

export type DiscussionInviteCandidatesInput = Readonly<{
    scope: ServerAccountScope;
    people: readonly SessionAccessCandidateRowModel[];
    sessions: readonly Readonly<{ address: SessionAddress; label: string | null; titleReadable: boolean; contextLabel?: string | null; agentId?: string | null; lastActivityAt?: number | null;
        access: Pick<SessionEffectiveAccessV1, 'capabilities'> | null;
        readiness?: SessionReadinessV1 | null; repair?: SessionReadinessRepairV1 | null }>[];
    modelOptions: readonly ExecutableParticipantPickerOption[];
    roster?: DiscussionParticipantsListResponseV1 | null;
}>;

type WithoutKey<T> = T extends unknown ? Omit<T, 'key'> : never;

/** A projection of existing inventories; never an access or execution admission decision. */
export function buildDiscussionInviteCandidates(input: DiscussionInviteCandidatesInput): readonly DiscussionInviteCandidate[] {
    const candidates: WithoutKey<DiscussionInviteCandidate>[] = [];
    for (const row of input.people) {
        if (row.principal.ref.kind !== 'account') continue;
        candidates.push({ kind: 'account',
            participant: row.principal.ref, principal: row.principal, availability: row.addition });
    }
    for (const row of input.sessions) {
        candidates.push({ kind: 'session',
            selection: { kind: 'session', session: row.address }, label: row.label, titleReadable: row.titleReadable,
            contextLabel: row.contextLabel ?? null, agentId: row.agentId ?? null,
            lastActivityAt: row.lastActivityAt ?? null,
            availability: { kind: 'existing_session' }, readiness: row.readiness ?? null, repair: row.repair ?? null });
    }
    for (const option of input.modelOptions) {
        const selection = option.value;
        if (selection.kind !== 'model') continue;
        candidates.push({ kind: 'model', selection, label: option.label, availability: option.readiness,
            readiness: option.readiness, repair: option.repair });
    }
    return projectDiscussionInviteCandidatesV1({ scope: input.scope, roster: input.roster, candidates,
        sessionAccess: new Map(input.sessions.filter(row => areServerProfileIdentifiersEquivalent(row.address.serverId, input.scope.serverId))
            .map(row => [row.address.sessionId, row.access])),
        isSameHome: serverId => areServerProfileIdentifiersEquivalent(serverId, input.scope.serverId) });
}
