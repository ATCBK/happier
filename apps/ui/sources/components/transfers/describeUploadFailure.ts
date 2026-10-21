import { t } from '@/text';
import type { TransferFailureReason } from '@/sync/domains/transfers/runtime/transferRuntime';

export function describeUploadFailureReason(reason: TransferFailureReason, machineName: string): string {
    switch (reason) {
        case 'unreachable': return t('projects.checkouts.notAnswering', { machine: machineName });
        case 'declined': return t('files.transfers.failureReasons.declined');
        case 'permission': return t('errors.permissionDenied');
        case 'tooLarge': return t('files.transfers.failureReasons.tooLarge');
        case 'unconfirmed': return t('files.transfers.failureReasons.unconfirmed');
        case 'other': return t('files.transfers.failureReasons.other', { machine: machineName });
    }
}

export function describeUploadFailure(reason: TransferFailureReason, machineName: string): string {
    return `${t('files.transfers.uploadFailed')} · ${describeUploadFailureReason(reason, machineName)}`;
}
