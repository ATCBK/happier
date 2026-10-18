import { t } from '@/text';

/** A definite refusal means the attempted relation was not committed. */
export function isReportsToRefusal(errorCode: string | undefined): boolean {
    return errorCode !== undefined && ['reports_to_cycle', 'reports_to_cas_conflict', 'reports_to_forbidden', 'credential_scope_denied'].includes(errorCode);
}

/** Shared words for an authoritative reports-to refusal. */
export function describeReportsToRefusal(errorCode: string | undefined): string {
    switch (errorCode) {
        case 'reports_to_cycle': return t('sessionWork.putUnder.errors.cycle');
        case 'reports_to_cas_conflict': return t('sessionWork.putUnder.errors.changed');
        case 'reports_to_forbidden':
        case 'credential_scope_denied': return t('sessionWork.putUnder.errors.forbidden');
        default: return t('sessionWork.putUnder.errors.failed');
    }
}
