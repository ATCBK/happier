import {
    readSessionInputAuthority,
    readSessionMessageProvenance,
} from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import type { SessionFollowInputV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';

function readHostInputAuthority(meta: unknown) {
    if (readSessionMessageProvenance(meta, 'stored')?.kind !== 'host') return null;
    const authority = readSessionInputAuthority(meta, 'stored');
    return authority?.v === 1 && authority.caller?.kind === 'host' ? authority : null;
}

/** Pending identity comes only from Home's separate admission projection, never authored metadata. */
export function isHostAuthoredInputMeta(meta: unknown, admittedPendingFollowInput?: SessionFollowInputV1 | null): boolean {
    return admittedPendingFollowInput != null || readHostInputAuthority(meta) !== null;
}

/** The existing admitted Follow facts distinguish a model prompt from a person's text. */
export function readHostFollowInputMeta(meta: unknown, admittedPendingFollowInput?: SessionFollowInputV1 | null): SessionFollowInputV1 | null {
    return admittedPendingFollowInput ?? readHostInputAuthority(meta)?.followDeliveryV1 ?? null;
}

/** An admitted Follow that asks the person for something: a session request, or a run/workflow needs-you event. */
export function followInputNeedsYou(input: SessionFollowInputV1): boolean {
    return 'requestEvents' in input || input.event.kind === 'needs_you';
}
