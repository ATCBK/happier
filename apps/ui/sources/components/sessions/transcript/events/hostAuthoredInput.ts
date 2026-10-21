import {
    readSessionInputAuthority,
    readSessionMessageProvenance,
} from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';

/** Host-generated input (including Follow and Run prompts) is never a person's message. */
export function isHostAuthoredInputMeta(meta: unknown): boolean {
    if (readSessionMessageProvenance(meta, 'stored')?.kind !== 'host') return false;
    const authority = readSessionInputAuthority(meta, 'stored');
    return authority?.v === 1 && authority.caller?.kind === 'host';
}
