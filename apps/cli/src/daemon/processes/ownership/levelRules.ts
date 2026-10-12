import type { ProcessEvidence, ProcessOwnershipLevel } from './types';

/** The only evidence-to-level decision; consumers project this result. */
export function resolveProcessOwnershipLevel(input: Readonly<{
    samePrincipal: boolean | undefined;
    ownerEnded: boolean;
    evidence: readonly ProcessEvidence[];
    observationsIncomplete: boolean;
}>): ProcessOwnershipLevel {
    if (input.samePrincipal === undefined) return 'unknown';
    if (!input.samePrincipal) return 'not_happier';
    const proof = input.evidence.some(item => item.kind !== 'group_and_port' && item.state === 'met');
    const likely = input.evidence.some(item => item.kind === 'group_and_port' && item.state === 'met');
    if (proof || likely) return input.ownerEnded ? 'left_behind' : proof ? 'proven' : 'likely';
    return input.observationsIncomplete ? 'unknown' : 'not_happier';
}
