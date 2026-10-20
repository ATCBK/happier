import { t } from '@/text';

/** A definite refusal means the attempted relation was not committed. */
export function isManagerRefusal(errorCode: string | undefined): boolean {
    return errorCode !== undefined && ['manager_cycle', 'manager_cas_conflict', 'manager_forbidden', 'credential_scope_denied'].includes(errorCode);
}

/** Shared words for an authoritative manager refusal. */
export function describeManagerRefusal(errorCode: string | undefined): string {
    switch (errorCode) {
        case 'manager_cycle': return t('sessionWork.putUnder.errors.cycle');
        case 'manager_cas_conflict': return t('sessionWork.putUnder.errors.changed');
        case 'manager_forbidden':
        case 'credential_scope_denied': return t('sessionWork.putUnder.errors.forbidden');
        default: return t('sessionWork.putUnder.errors.failed');
    }
}
