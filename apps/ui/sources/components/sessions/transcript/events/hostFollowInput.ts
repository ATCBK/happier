import {
    readSessionInputAuthority,
    readSessionMessageProvenance,
} from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';

/** Follow context is agent input, but the host—not a person—authored its transcript notice. */
export function isHostFollowInputMeta(meta: unknown): boolean {
    if (readSessionMessageProvenance(meta, 'stored')?.kind !== 'host') return false;
    const authority = readSessionInputAuthority(meta, 'stored');
    return authority?.v === 1 && authority.followDeliveryV1 !== undefined;
}
