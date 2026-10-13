import { t } from '@/text';

/** Shared words for an authoritative reports-to refusal. */
export function describeReportsToRefusal(errorCode: string | undefined): string {
    switch (errorCode) {
        case 'reports_to_cycle': return t('sessionWork.putUnder.errors.cycle');
        case 'reports_to_cas_conflict': return t('sessionWork.putUnder.errors.changed');
        case 'reports_to_forbidden': return t('sessionWork.putUnder.errors.forbidden');
        default: return t('sessionWork.putUnder.errors.failed');
    }
}
